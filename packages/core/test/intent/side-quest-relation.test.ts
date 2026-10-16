import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { askQuestion, openStint, recordTrace } from "../../src/intent/api";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { currentHeroId } from "../../src/intent/identity";
import { applyIncremental, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { dailyReport } from "../../src/report/daily";
import { queryQuests, querySideQuests } from "../../src/report/intent-queries";
import { appendLegacyDeclaredSideQuest } from "../fixtures/legacy-side-quest";
import { REPORT_CONFIG } from "../fixtures/report-golden/seed";

registerAllProjections();

type Database = ReturnType<typeof openDatabase>;

let dir: string;
let errors: string[];
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tempad-side-quest-"));
  errors = [];
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
});

afterEach(() => {
  errorSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

async function harness() {
  const database = openDatabase(join(dir, "tempad.db"));
  const lines: string[] = [];
  const context = {
    database,
    config: { home: dir, hostSlug: "host" } as Config,
    intentConfig: defaultIntentConfig(),
    stdout: (line: string) => lines.push(line),
  };
  const run = (args: string[]) => runIntentCommand(args, context);
  expect(await run(["hero", "init", "S"])).toBe(0);
  const store = new EventStore(database);
  return { database, lines, run, store };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function addQuest(h: Harness, title: string): Promise<string> {
  expect(await h.run(["quest", "add", "--owner", "hero", title])).toBe(0);
  return questId(h.database, title);
}

function questId(database: Database, title: string): string {
  return (database.query("SELECT id FROM quests WHERE title = ?").get(title) as { id: string }).id;
}

interface Relation {
  stint: string | null;
  quest: string | null;
  branched: number;
  trigger: string | null;
  kind: string | null;
}

function relation(database: Database, id: string): Relation {
  return database
    .query(
      `SELECT deviates_from_stint_id AS stint, deviates_from_quest_id AS quest,
              branched_at IS NOT NULL AS branched, trigger, branch_kind AS kind
         FROM quests WHERE id = ?`,
    )
    .get(id) as Relation;
}

const NO_RELATION: Relation = { stint: null, quest: null, branched: 0, trigger: null, kind: null };

function questRows(database: Database) {
  return database.query("SELECT * FROM quests ORDER BY id").all();
}

async function list(h: Harness, ...flags: string[]): Promise<string[]> {
  h.lines.length = 0;
  expect(await h.run(["quest", "list", ...flags])).toBe(0);
  return [...h.lines];
}

describe("quest.branched shapes in the quests projection", () => {
  test("declare --new --deviates-from writes the relation on the new quest, naming the parent", async () => {
    const h = await harness();
    const main = await addQuest(h, "Main");

    expect(
      await h.run([
        "quest",
        "declare",
        "--session",
        "s1",
        "--new",
        "Side",
        "--outcome",
        "o",
        "--deviates-from",
        main,
        "--trigger",
        "noticed",
        "--kind",
        "blocker",
      ]),
    ).toBe(0);
    const side = questId(h.database, "Side");

    const branched = h.database
      .query("SELECT subject, payload FROM events WHERE kind = 'quest.branched'")
      .get() as { subject: string; payload: string };
    expect(branched.subject).toBe(side);
    expect(JSON.parse(branched.payload)).toEqual({
      deviates_from_quest: main,
      trigger: "noticed",
      kind: "blocker",
    });
    expect(relation(h.database, side)).toEqual({
      stint: null,
      quest: main,
      branched: 1,
      trigger: "noticed",
      kind: "blocker",
    });
    expect(relation(h.database, main)).toEqual(NO_RELATION);
  });

  test("a legacy inverted declare event rebuilds as the new quest deviating from the parent", async () => {
    const h = await harness();
    const main = await addQuest(h, "Main");
    const side = appendLegacyDeclaredSideQuest(h.store, {
      heroId: currentHeroId(h.database) as string,
      parentQuestId: main,
      title: "Side",
      at: "2026-09-01T10:00:00.000Z",
      trigger: "saw a flake",
      kind: "curiosity",
    });

    rebuildAll(h.database);

    expect(relation(h.database, side)).toEqual({
      stint: null,
      quest: main,
      branched: 1,
      trigger: "saw a flake",
      kind: "curiosity",
    });
    expect(relation(h.database, main)).toEqual(NO_RELATION);
  });

  test("a legacy declare event no longer overwrites the parent's own side-quest relation", async () => {
    const h = await harness();
    const root = await addQuest(h, "Root");
    const rootStint = openStint(h.store, h.database, {
      outcome: "root work",
      quest: root,
      at: "2026-09-01T08:00:00.000Z",
      actor: "hook",
    });
    const middle = await addQuest(h, "Middle");
    expect(
      await h.run([
        "quest",
        "branch",
        middle,
        "--deviates-from",
        rootStint,
        "--trigger",
        "blocked",
        "--kind",
        "blocker",
      ]),
    ).toBe(0);
    const leaf = appendLegacyDeclaredSideQuest(h.store, {
      heroId: currentHeroId(h.database) as string,
      parentQuestId: middle,
      title: "Leaf",
      at: "2026-09-01T11:00:00.000Z",
    });

    rebuildAll(h.database);

    expect(relation(h.database, middle)).toMatchObject({ stint: rootStint, quest: null });
    expect(relation(h.database, leaf)).toMatchObject({ stint: null, quest: middle });
    expect(relation(h.database, root)).toEqual(NO_RELATION);
  });

  test("quest branch with a stint id keeps the stint-shaped event and row", async () => {
    const h = await harness();
    const main = await addQuest(h, "Main");
    const stint = openStint(h.store, h.database, {
      outcome: "main work",
      quest: main,
      at: "2026-09-01T09:00:00.000Z",
      actor: "hook",
    });
    const side = await addQuest(h, "Side");

    expect(await h.run(["quest", "branch", side, "--deviates-from", stint, "--trigger", "t"])).toBe(
      0,
    );

    const payload = JSON.parse(
      (
        h.database.query("SELECT payload FROM events WHERE kind = 'quest.branched'").get() as {
          payload: string;
        }
      ).payload,
    );
    expect(payload).toEqual({ deviates_from: stint, trigger: "t", kind: "unknown" });
    expect(relation(h.database, side)).toMatchObject({ stint, quest: null, branched: 1 });
    expect(relation(h.database, main)).toEqual(NO_RELATION);
  });

  test("quest branch with a quest id names the quest", async () => {
    const h = await harness();
    const main = await addQuest(h, "Main");
    const side = await addQuest(h, "Side");

    expect(await h.run(["quest", "branch", side, "--deviates-from", main, "--trigger", "t"])).toBe(
      0,
    );

    expect(relation(h.database, side)).toMatchObject({ stint: null, quest: main, branched: 1 });
    expect(relation(h.database, main)).toEqual(NO_RELATION);
  });

  test("quest branch refuses a quest deviating from itself, or from a retracted quest", async () => {
    const h = await harness();
    const main = await addQuest(h, "Main");
    const gone = await addQuest(h, "Gone");
    await h.run(["quest", "retract", gone, "--reason", "oops"]);
    errors.length = 0;

    expect(await h.run(["quest", "branch", main, "--deviates-from", main, "--trigger", "t"])).toBe(
      1,
    );
    expect(errors.join("\n")).toContain("cannot deviate from itself");
    expect(await h.run(["quest", "branch", main, "--deviates-from", gone, "--trigger", "t"])).toBe(
      1,
    );
    expect(errors.join("\n")).toContain(`quest ${gone} is retracted`);
    expect(
      await h.run([
        "quest",
        "branch",
        main,
        "--deviates-from",
        main,
        "--trigger",
        "t",
        "--at",
        "x",
      ]),
    ).toBe(2);
    expect(h.database.query("SELECT 1 FROM events WHERE kind = 'quest.branched'").get()).toBeNull();
  });

  test("a legacy hand-run quest branch that passed a quest id reads as the subject deviating from it", async () => {
    const h = await harness();
    const main = await addQuest(h, "Main");
    const side = await addQuest(h, "Side");
    // Before `quest branch` accepted a quest id, it wrote whatever it was given
    // as `deviates_from`. The quest named was created earlier, so this is not
    // the declare signature.
    h.store.append({
      actor: "hero",
      kind: "quest.branched",
      subject: side,
      at: "2099-01-01T00:00:00.000Z",
      payload: { deviates_from: main, trigger: "t", kind: "unknown" },
    });

    rebuildAll(h.database);

    expect(relation(h.database, side)).toMatchObject({ stint: null, quest: main, branched: 1 });
    expect(relation(h.database, main)).toEqual(NO_RELATION);
  });

  test("a branch with no origin stores no origin rather than the string 'null'", async () => {
    const h = await harness();
    const side = await addQuest(h, "Side");
    h.store.append({
      actor: "hero",
      kind: "quest.branched",
      subject: side,
      payload: { deviates_from: null, trigger: "t", kind: "unknown" },
    });

    rebuildAll(h.database);

    expect(relation(h.database, side)).toMatchObject({ stint: null, quest: null, branched: 1 });
    expect((await list(h, "--side")).join("\n")).toContain(
      "Side  (started)  side quest of unknown",
    );
  });

  test("incremental application and a full rebuild agree on a log mixing every shape", async () => {
    const h = await harness();
    const main = await addQuest(h, "Main");
    const stint = openStint(h.store, h.database, {
      outcome: "main work",
      quest: main,
      at: "2026-09-01T09:00:00.000Z",
      actor: "hook",
    });
    const byStint = await addQuest(h, "By stint");
    await h.run(["quest", "branch", byStint, "--deviates-from", stint, "--trigger", "t"]);
    const byQuest = await addQuest(h, "By quest");
    await h.run(["quest", "branch", byQuest, "--deviates-from", main, "--trigger", "t"]);
    await h.run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Declared",
      "--outcome",
      "o",
      "--origin",
      main,
      "--trigger",
      "t",
      "--kind",
      "waiting",
    ]);
    const legacy = appendLegacyDeclaredSideQuest(h.store, {
      heroId: currentHeroId(h.database) as string,
      parentQuestId: byQuest,
      title: "Legacy",
      at: "2026-09-01T12:00:00.000Z",
    });
    // The legacy events were appended without projecting them; replay them
    // incrementally the way the live database saw them back then.
    for (const event of h.store.read().filter((each) => each.subject === legacy)) {
      applyIncremental(h.database, event);
    }
    const legacyBranch = h.store
      .read()
      .find(
        (each) =>
          each.kind === "quest.branched" &&
          (each.payload as { deviates_from?: unknown }).deviates_from === legacy,
      );
    applyIncremental(h.database, legacyBranch as NonNullable<typeof legacyBranch>);

    const incremental = questRows(h.database);
    rebuildAll(h.database);
    expect(questRows(h.database)).toEqual(incremental);

    expect(relation(h.database, legacy)).toMatchObject({ quest: byQuest, stint: null });
    expect(relation(h.database, byQuest)).toMatchObject({ quest: main, stint: null });
    expect(relation(h.database, byStint)).toMatchObject({ quest: null, stint });
    expect(relation(h.database, questId(h.database, "Declared"))).toMatchObject({ quest: main });
    expect(relation(h.database, main)).toEqual(NO_RELATION);
  });
});

/**
 * The operator fixes side quests long after the fact: a quest declared hours
 * earlier, in its own session, is later recorded as a side quest of another.
 */
describe("making a quest a side quest after the fact", () => {
  const MAIN_SESSION = "11111111-1111-4111-8111-111111111111";
  const SIDE_SESSION = "22222222-2222-4222-8222-222222222222";

  function insertSession(database: Database, id: string, startedAt: string, endedAt: string) {
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES (?, '~/.claude', '-work-acme-widgets', ?, '/work/acme/widgets', 'acme', 'widgets', NULL, NULL, NULL, 'main', ?, ?, 1, 0, '["sonnet"]', 'test-host', ?)`,
      )
      .run(id, `/tmp/${id}.jsonl`, startedAt, endedAt, endedAt);
  }

  function workOn(
    h: Harness,
    quest: string,
    sessionId: string,
    startedAt: string,
    endedAt: string,
  ): string {
    const stint = openStint(h.store, h.database, {
      outcome: `work on ${quest}`,
      quest,
      at: startedAt,
      actor: "hook",
    });
    recordTrace(h.store, h.database, {
      stint,
      tool: "claude-code",
      place: "acme/widgets",
      source: "session",
      startedAt,
      endedAt,
      who: "hero",
      what: "work",
      why: "ship",
      where: "acme/widgets",
      how: "claude-code",
      confidence: 0.9,
      classifiedBy: "assistant",
      actor: "hook",
      sessionId,
    });
    return stint;
  }

  async function declare(h: Harness, session: string, title: string, at: string, extra: string[]) {
    expect(
      await h.run([
        "quest",
        "declare",
        "--session",
        session,
        "--new",
        title,
        "--outcome",
        "o",
        "--by",
        "hero",
        "--at",
        at,
        ...extra,
      ]),
    ).toBe(0);
    return questId(h.database, title);
  }

  /** Main declared at 09:00Z and worked until 10:00Z; Side declared at 10:00Z, worked until 11:00Z, unrelated. */
  async function twoQuests() {
    const h = await harness();
    insertSession(h.database, MAIN_SESSION, "2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z");
    insertSession(h.database, SIDE_SESSION, "2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z");
    const main = await declare(h, MAIN_SESSION, "Main", "2026-09-01T09:00:00.000Z", []);
    const mainStint = workOn(
      h,
      main,
      MAIN_SESSION,
      "2026-09-01T09:00:00.000Z",
      "2026-09-01T10:00:00.000Z",
    );
    const side = await declare(h, SIDE_SESSION, "Side", "2026-09-01T10:00:00.000Z", []);
    const sideStint = workOn(
      h,
      side,
      SIDE_SESSION,
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T11:00:00.000Z",
    );
    return { h, main, side, mainStint, sideStint };
  }

  const DAY = { from: "2026-09-01", to: "2026-09-01", timeZone: REPORT_CONFIG.tz };

  function render(database: Database): string {
    return dailyReport.render(database, REPORT_CONFIG, { from: DAY.from, to: DAY.to });
  }

  async function expectSideOfMain(
    h: Harness,
    main: string,
    side: string,
    sideStint: string,
    from: string,
  ) {
    const lines = await list(h);
    expect(lines.find((line) => line.startsWith(side))).toContain(`side quest of ${main}`);
    expect(lines.find((line) => line.startsWith(main))).not.toContain("side quest of");
    expect(await list(h, "--side")).toEqual([expect.stringContaining(side)]);

    const sideQuests = querySideQuests(h.database, DAY);
    expect(sideQuests).toHaveLength(1);
    expect(sideQuests[0]).toMatchObject({
      id: side,
      fromQuestId: main,
      fromQuestTitle: "Main",
      minutes: 60,
      org: "acme",
      project: "widgets",
    });
    const quests = queryQuests(h.database, DAY);
    expect(quests.find((quest) => quest.id === main)?.sideQuestMinutes).toBe(60);
    expect(quests.find((quest) => quest.id === side)?.sideQuestMinutes).toBe(0);
    // The side quest keeps its own stint and minutes.
    expect(
      (
        h.database.query("SELECT quest_id FROM stints WHERE id = ?").get(sideStint) as {
          quest_id: string;
        }
      ).quest_id,
    ).toBe(side);

    const report = render(h.database);
    expect(report).toContain("#### Side quests");
    expect(report).toContain(`- Side, branched 07:00 from "${from}"`);
    expect(report).not.toMatch(/- Main, branched/);
  }

  test("quest branch --deviates-from <quest> --at relinks it and every view agrees, before and after a rebuild", async () => {
    const { h, main, side, sideStint } = await twoQuests();
    expect((await list(h, "--side")).length).toBe(0);

    expect(
      await h.run([
        "quest",
        "branch",
        side,
        "--deviates-from",
        main,
        "--trigger",
        "the build broke",
        "--kind",
        "blocker",
        "--at",
        "2026-09-01T10:00:00.000Z",
      ]),
    ).toBe(0);

    await expectSideOfMain(h, main, side, sideStint, "Main");
    rebuildAll(h.database);
    await expectSideOfMain(h, main, side, sideStint, "Main");

    expect(await h.run(["quest", "return", side, "--to", main])).toBe(0);
    expect(querySideQuests(h.database, DAY)[0]?.returnedAt).not.toBeNull();
  });

  test("quest branch --deviates-from <stint> relinks it to the stint and its quest", async () => {
    const { h, main, side, mainStint, sideStint } = await twoQuests();

    expect(
      await h.run([
        "quest",
        "branch",
        side,
        "--deviates-from",
        mainStint,
        "--trigger",
        "t",
        "--at",
        "2026-09-01T10:00:00.000Z",
      ]),
    ).toBe(0);

    await expectSideOfMain(h, main, side, sideStint, `work on ${main}`);
    expect(relation(h.database, side)).toMatchObject({ stint: mainStint, quest: null });
  });

  test("a later branch moves a side quest to a different parent", async () => {
    const { h, main, side, mainStint, sideStint } = await twoQuests();
    const other = await addQuest(h, "Other");
    await h.run(["quest", "branch", side, "--deviates-from", other, "--trigger", "t"]);

    await h.run([
      "quest",
      "branch",
      side,
      "--deviates-from",
      mainStint,
      "--trigger",
      "t",
      "--at",
      "2026-09-01T10:00:00.000Z",
    ]);

    expect(relation(h.database, side)).toMatchObject({ stint: mainStint, quest: null });
    rebuildAll(h.database);
    await expectSideOfMain(h, main, side, sideStint, `work on ${main}`);
  });

  test("declare --at hours earlier with --deviates-from records the side quest at that time", async () => {
    const h = await harness();
    insertSession(h.database, MAIN_SESSION, "2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z");
    insertSession(h.database, SIDE_SESSION, "2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z");
    const main = await declare(h, MAIN_SESSION, "Main", "2026-09-01T09:00:00.000Z", []);
    workOn(h, main, MAIN_SESSION, "2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z");
    const side = await declare(h, SIDE_SESSION, "Side", "2026-09-01T10:00:00.000Z", [
      "--deviates-from",
      main,
      "--trigger",
      "t",
      "--kind",
      "curiosity",
    ]);
    const sideStint = workOn(
      h,
      side,
      SIDE_SESSION,
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T11:00:00.000Z",
    );

    await expectSideOfMain(h, main, side, sideStint, "Main");
    rebuildAll(h.database);
    await expectSideOfMain(h, main, side, sideStint, "Main");
  });

  test("a legacy inverted declaration shows the right relation in every view after a rebuild", async () => {
    const h = await harness();
    insertSession(h.database, MAIN_SESSION, "2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z");
    insertSession(h.database, SIDE_SESSION, "2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z");
    const main = await declare(h, MAIN_SESSION, "Main", "2026-09-01T09:00:00.000Z", []);
    workOn(h, main, MAIN_SESSION, "2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z");
    const side = appendLegacyDeclaredSideQuest(h.store, {
      heroId: currentHeroId(h.database) as string,
      parentQuestId: main,
      title: "Side",
      at: "2026-09-01T10:00:00.000Z",
      sessionId: SIDE_SESSION,
    });
    rebuildAll(h.database);
    const sideStint = workOn(
      h,
      side,
      SIDE_SESSION,
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T11:00:00.000Z",
    );

    await expectSideOfMain(h, main, side, sideStint, "Main");
  });

  test("answering a doubt hours later with --quest new: --origin current splits the work off as a side quest", async () => {
    const h = await harness();
    insertSession(h.database, MAIN_SESSION, "2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z");
    const main = await declare(h, MAIN_SESSION, "Main", "2026-09-01T09:00:00.000Z", []);
    const earlier = workOn(
      h,
      main,
      MAIN_SESSION,
      "2026-09-01T09:00:00.000Z",
      "2026-09-01T09:30:00.000Z",
    );
    const doubtedStint = openStint(h.store, h.database, {
      outcome: "compare libraries",
      quest: main,
      at: "2026-09-01T09:30:00.000Z",
      actor: "hook",
    });
    const trace = recordTrace(h.store, h.database, {
      stint: doubtedStint,
      tool: "claude-code",
      place: "acme/widgets",
      source: "session",
      startedAt: "2026-09-01T09:30:00.000Z",
      endedAt: "2026-09-01T10:00:00.000Z",
      who: "hero",
      what: "compare",
      why: "unknown",
      where: "acme/widgets",
      how: "claude-code",
      confidence: 0.9,
      classifiedBy: "assistant",
      actor: "hook",
      sessionId: MAIN_SESSION,
    });
    const question = askQuestion(h.store, h.database, {
      trace,
      sessionId: MAIN_SESSION,
      kind: "belongs",
      text: "belongs",
      guess: "a library comparison",
      actor: "hook",
    });

    expect(
      await h.run([
        "answer",
        question,
        "--quest",
        "new:Compare libraries",
        "--origin",
        "current",
        "--trigger",
        "wondered about alternatives",
        "--kind",
        "curiosity",
      ]),
    ).toBe(0);
    const side = questId(h.database, "Compare libraries");

    for (const pass of ["incremental", "rebuilt"]) {
      if (pass === "rebuilt") rebuildAll(h.database);
      // The earlier stint of the quest being left is the origin, never the
      // doubted stint, which moves to the side quest.
      expect(relation(h.database, side)).toMatchObject({
        stint: earlier,
        quest: null,
        branched: 1,
        trigger: "wondered about alternatives",
        kind: "curiosity",
      });
      expect(relation(h.database, main)).toEqual(NO_RELATION);
      expect(
        (
          h.database.query("SELECT quest_id FROM stints WHERE id = ?").get(doubtedStint) as {
            quest_id: string;
          }
        ).quest_id,
      ).toBe(side);
      const lines = await list(h);
      expect(lines.find((line) => line.startsWith(side))).toContain(`side quest of ${main}`);
      expect(lines.find((line) => line.startsWith(main))).not.toContain("side quest of");
    }
  });

  test("quest list --as-of before the relink shows no side quest", async () => {
    const { h, side, main } = await twoQuests();
    await h.run([
      "quest",
      "branch",
      side,
      "--deviates-from",
      main,
      "--trigger",
      "t",
      "--at",
      "2026-09-01T10:30:00.000Z",
    ]);

    expect(await list(h, "--side", "--as-of", "2026-09-01T10:15:00.000Z")).toEqual([]);
    expect(await list(h, "--side", "--as-of", "2026-09-01T10:45:00.000Z")).toEqual([
      expect.stringContaining(`side quest of ${main}`),
    ]);
  });
});

describe("quest branch and declare arguments", () => {
  const SESSION = "33333333-3333-4333-8333-333333333333";

  function branchedAt(database: Database, id: string): string | null {
    return (
      database.query("SELECT branched_at FROM quests WHERE id = ?").get(id) as {
        branched_at: string | null;
      }
    ).branched_at;
  }

  function eventAt(database: Database, kind: string): string[] {
    return (
      database.query("SELECT at FROM events WHERE kind = ? ORDER BY uid").all(kind) as {
        at: string;
      }[]
    ).map((row) => row.at);
  }

  test("quest branch --at with a UTC offset is stored as UTC milliseconds", async () => {
    const h = await harness();
    const main = await addQuest(h, "Main");
    const side = await addQuest(h, "Side");

    expect(
      await h.run([
        "quest",
        "branch",
        side,
        "--deviates-from",
        main,
        "--trigger",
        "t",
        "--at",
        "2026-09-01T07:00:00-03:00",
      ]),
    ).toBe(0);

    expect(eventAt(h.database, "quest.branched")).toEqual(["2026-09-01T10:00:00.000Z"]);
    expect(branchedAt(h.database, side)).toBe("2026-09-01T10:00:00.000Z");
    rebuildAll(h.database);
    expect(branchedAt(h.database, side)).toBe("2026-09-01T10:00:00.000Z");
  });

  test("quest branch with an unparseable --at exits 2 and writes nothing", async () => {
    const h = await harness();
    const main = await addQuest(h, "Main");
    const side = await addQuest(h, "Side");

    expect(
      await h.run([
        "quest",
        "branch",
        side,
        "--deviates-from",
        main,
        "--trigger",
        "t",
        "--at",
        "yesterday-ish",
      ]),
    ).toBe(2);
    expect(errors.join("\n")).toContain("--at must be an ISO date or timestamp, got yesterday-ish");
    expect(eventAt(h.database, "quest.branched")).toEqual([]);
  });

  test("declare --at with a UTC offset records every event at the UTC instant", async () => {
    const h = await harness();
    const main = await addQuest(h, "Main");

    expect(
      await h.run([
        "quest",
        "declare",
        "--session",
        SESSION,
        "--new",
        "Side",
        "--outcome",
        "o",
        "--by",
        "hero",
        "--deviates-from",
        main,
        "--trigger",
        "t",
        "--kind",
        "curiosity",
        "--at",
        "2026-09-01T07:00:00-03:00",
      ]),
    ).toBe(0);

    const side = questId(h.database, "Side");
    expect(eventAt(h.database, "quest.created").at(-1)).toBe("2026-09-01T10:00:00.000Z");
    expect(eventAt(h.database, "quest.branched")).toEqual(["2026-09-01T10:00:00.000Z"]);
    expect(eventAt(h.database, "quest.declared")).toEqual(["2026-09-01T10:00:00.000Z"]);
    expect(relation(h.database, side)).toMatchObject({ quest: main, branched: 1 });
    expect(branchedAt(h.database, side)).toBe("2026-09-01T10:00:00.000Z");
  });

  test("declare with an unparseable --at exits 2 and writes nothing", async () => {
    const h = await harness();
    const before = (h.database.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

    expect(
      await h.run([
        "quest",
        "declare",
        "--session",
        SESSION,
        "--new",
        "Side",
        "--outcome",
        "o",
        "--by",
        "hero",
        "--at",
        "not a date",
      ]),
    ).toBe(2);
    expect(errors.join("\n")).toContain("--at must be an ISO date or timestamp, got not a date");
    expect(h.database.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: before });
  });

  test("quest branch refuses a --deviates-from id that is neither a quest nor a stint", async () => {
    const h = await harness();
    const side = await addQuest(h, "Side");
    const unknown = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    expect(
      await h.run(["quest", "branch", side, "--deviates-from", unknown, "--trigger", "t"]),
    ).toBe(1);
    expect(errors.join("\n")).toContain(
      `--deviates-from ${unknown} is neither a quest nor a stint`,
    );
    expect(eventAt(h.database, "quest.branched")).toEqual([]);
    expect(relation(h.database, side)).toEqual(NO_RELATION);
  });

  test("quest branch refuses a retracted stint", async () => {
    const h = await harness();
    const main = await addQuest(h, "Main");
    const side = await addQuest(h, "Side");
    const stint = openStint(h.store, h.database, { actor: "hero", quest: main, outcome: "work" });
    const opened = h.database
      .query("SELECT id FROM events WHERE kind = 'stint.opened' AND subject = ?")
      .get(stint) as { id: number };
    applyIncremental(
      h.database,
      h.store.append({
        actor: "hero",
        kind: "retracted",
        subject: stint,
        payload: { retracts: opened.id, reason: "wrong" },
      }),
    );

    expect(await h.run(["quest", "branch", side, "--deviates-from", stint, "--trigger", "t"])).toBe(
      1,
    );
    expect(errors.join("\n")).toContain(`stint ${stint} is retracted`);
    expect(eventAt(h.database, "quest.branched")).toEqual([]);
  });
});
