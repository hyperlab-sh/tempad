import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import {
  activeDeclaredQuests,
  currentDeclaredQuest,
  currentDeclaredQuestForSubagent,
  declareQuest,
  latestDeclaredParentSessionId,
  sessionHasActiveDeclaration,
} from "../../src/intent/declarations";
import { applyIncremental, ensureTables, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";

registerAllProjections();

const SESSION_START = "2026-09-04T14:00:00.000Z";

type Fixture = ReturnType<typeof seed>;

function seed(options: { session?: boolean } = {}) {
  const database = openDatabase(":memory:");
  ensureTables(database);
  const store = new EventStore(database);
  applyIncremental(
    database,
    store.append({ actor: "hero", kind: "hero.created", subject: "H1", payload: { name: "S" } }),
  );
  for (const id of ["Q1", "Q2", "Q3"]) {
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: id,
        payload: {
          owner: { kind: "hero", id: "H1" },
          title: `Quest ${id}`,
          confirmed: true,
          origin_kind: "declared",
        },
      }),
    );
  }
  const insertSession = (id: string) =>
    database
      .query(
        `INSERT INTO claude_sessions
          (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
           started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES (?, '/c', 'p', ?, '/w/p', 'personal', 'p', 't', 'main', ?, '2026-09-04T18:00:00.000Z', 1, 0, '[]', 'host', '2026-09-04T18:00:00.000Z')`,
      )
      .run(id, `/c/p/${id}.jsonl`, SESSION_START);
  if (options.session !== false) {
    insertSession("s1");
    insertSession("sub");
  }
  return { database, store };
}

function declare(
  { database, store }: Fixture,
  at: string,
  questId: string,
  extra: {
    done?: boolean;
    since?: string;
    plan?: string[];
    sessionId?: string;
    parentSessionId?: string;
  } = {},
) {
  declareQuest(store, database, {
    sessionId: extra.sessionId ?? "s1",
    parentSessionId: extra.parentSessionId,
    questId,
    plan: extra.plan ?? [],
    scope: extra.parentSessionId ? "subagent" : "session",
    declaredBy: "agent",
    at,
    heroId: "H1",
    done: extra.done,
    since: extra.since,
  });
}

const activeIds = (fixture: Fixture, at: string, sessionId = "s1") =>
  activeDeclaredQuests(fixture.database, { sessionId, at }).map((quest) => quest.questId);

describe("a declaration covers the session from its start", () => {
  test("the first declaration is active from the session's start, not from its own event", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1");

    expect(activeIds(fixture, "2026-09-04T14:00:00.000Z")).toEqual(["Q1"]);
    expect(activeIds(fixture, "2026-09-04T15:30:00.000Z")).toEqual(["Q1"]);
    expect(activeIds(fixture, "2026-09-04T16:30:00.000Z")).toEqual(["Q1"]);
    // Nothing is declared for work before the session began.
    expect(activeIds(fixture, "2026-09-04T13:59:59.999Z")).toEqual([]);
  });

  test("a session with no stored row has no start to reach back to: it covers from its own event", () => {
    const fixture = seed({ session: false });
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1");

    expect(activeIds(fixture, "2026-09-04T15:59:59.999Z")).toEqual([]);
    expect(activeIds(fixture, "2026-09-04T16:00:00.000Z")).toEqual(["Q1"]);
  });

  test("a second declaration made while the first is still open starts at its own event", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T15:00:00.000Z", "Q1");
    declare(fixture, "2026-09-04T17:00:00.000Z", "Q2");

    expect(activeIds(fixture, "2026-09-04T16:59:59.999Z")).toEqual(["Q1"]);
    expect(activeIds(fixture, "2026-09-04T17:00:00.000Z")).toEqual(["Q1", "Q2"]);
    expect(
      activeDeclaredQuests(fixture.database, {
        sessionId: "s1",
        at: "2026-09-04T17:30:00.000Z",
      }).map((quest) => quest.alias),
    ).toEqual(["Q1", "Q2"]);
  });

  test("a second declaration after every earlier quest was ended starts where the last --done happened", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T15:00:00.000Z", "Q1");
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1", { done: true });
    declare(fixture, "2026-09-04T17:00:00.000Z", "Q2");

    expect(activeIds(fixture, "2026-09-04T15:30:00.000Z")).toEqual(["Q1"]);
    expect(activeIds(fixture, "2026-09-04T16:00:00.000Z")).toEqual(["Q2"]);
    expect(activeIds(fixture, "2026-09-04T16:30:00.000Z")).toEqual(["Q2"]);
    expect(activeIds(fixture, "2026-09-04T17:30:00.000Z")).toEqual(["Q2"]);
  });

  test("with two quests open and only one ended, a third declaration still starts at its own event", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T15:00:00.000Z", "Q1");
    declare(fixture, "2026-09-04T15:10:00.000Z", "Q2");
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1", { done: true });
    declare(fixture, "2026-09-04T17:00:00.000Z", "Q3");

    expect(activeIds(fixture, "2026-09-04T16:30:00.000Z")).toEqual(["Q2"]);
    expect(activeIds(fixture, "2026-09-04T17:00:00.000Z")).toEqual(["Q2", "Q3"]);
  });

  test("--since overrides the computed start, for the first declaration and a later one", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1", { since: "2026-09-04T15:30:00.000Z" });
    declare(fixture, "2026-09-04T18:00:00.000Z", "Q2", { since: "2026-09-04T16:45:00.000Z" });

    expect(activeIds(fixture, "2026-09-04T15:29:59.999Z")).toEqual([]);
    expect(activeIds(fixture, "2026-09-04T15:30:00.000Z")).toEqual(["Q1"]);
    expect(activeIds(fixture, "2026-09-04T16:44:00.000Z")).toEqual(["Q1"]);
    expect(activeIds(fixture, "2026-09-04T16:45:00.000Z")).toEqual(["Q1", "Q2"]);
  });

  test("--since may be the declaration's own instant, but never after it", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1", { since: "2026-09-04T16:00:00.000Z" });
    expect(activeIds(fixture, "2026-09-04T15:59:59.999Z")).toEqual([]);

    expect(() =>
      declare(fixture, "2026-09-04T16:00:00.000Z", "Q2", { since: "2026-09-04T16:00:00.001Z" }),
    ).toThrow("is after the declaration");
    expect(() =>
      declare(fixture, "2026-09-04T16:00:00.000Z", "Q2", { since: "not a date" }),
    ).toThrow("not a timestamp");
    expect(() =>
      declare(fixture, "2026-09-04T16:00:00.000Z", "Q1", {
        done: true,
        since: "2026-09-04T15:00:00.000Z",
      }),
    ).toThrow("does not apply to --done");
  });

  test("the plan in force is the latest amendment by then, the first declaration's before any", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T15:00:00.000Z", "Q1", { plan: ["first"] });
    declare(fixture, "2026-09-04T17:00:00.000Z", "Q1", { plan: ["amended"] });

    const planAt = (at: string) =>
      activeDeclaredQuests(fixture.database, { sessionId: "s1", at })[0]?.plan;
    expect(planAt("2026-09-04T14:30:00.000Z")).toEqual(["first"]);
    expect(planAt("2026-09-04T16:00:00.000Z")).toEqual(["first"]);
    expect(planAt("2026-09-04T17:00:00.000Z")).toEqual(["amended"]);
  });

  test("a quest declared again after its own --done opens a new stretch by the same rules", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T15:00:00.000Z", "Q1");
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1", { done: true });
    declare(fixture, "2026-09-04T18:00:00.000Z", "Q1");

    expect(activeIds(fixture, "2026-09-04T15:30:00.000Z")).toEqual(["Q1"]);
    // Every earlier quest was ended at 16:00, so the new stretch has no gap.
    expect(activeIds(fixture, "2026-09-04T16:00:00.000Z")).toEqual(["Q1"]);
    expect(activeIds(fixture, "2026-09-04T17:00:00.000Z")).toEqual(["Q1"]);
  });
});

describe("the other readers agree with the coverage rule", () => {
  test("sessionHasActiveDeclaration and currentDeclaredQuest answer for a window before the declaration", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1");

    const early = "2026-09-04T14:30:00.000Z";
    expect(sessionHasActiveDeclaration(fixture.database, { sessionId: "s1", at: early })).toBe(
      true,
    );
    expect(currentDeclaredQuest(fixture.database, { sessionId: "s1", at: early })?.questId).toBe(
      "Q1",
    );
    const before = "2026-09-04T13:00:00.000Z";
    expect(sessionHasActiveDeclaration(fixture.database, { sessionId: "s1", at: before })).toBe(
      false,
    );
    expect(currentDeclaredQuest(fixture.database, { sessionId: "s1", at: before })).toBeNull();
  });

  test("currentDeclaredQuest follows coverage across a --done: the later quest from the done on", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T15:00:00.000Z", "Q1");
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1", { done: true });
    declare(fixture, "2026-09-04T17:00:00.000Z", "Q2");

    const at = (time: string) =>
      currentDeclaredQuest(fixture.database, { sessionId: "s1", at: time })?.questId;
    expect(at("2026-09-04T15:30:00.000Z")).toBe("Q1");
    expect(at("2026-09-04T16:30:00.000Z")).toBe("Q2");
    expect(at("2026-09-04T17:30:00.000Z")).toBe("Q2");
  });

  test("a subagent's first declaration covers its own session from its start, and so does its parent link", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q2", {
      sessionId: "sub",
      parentSessionId: "s1",
    });
    const early = "2026-09-04T14:30:00.000Z";

    expect(
      activeDeclaredQuests(fixture.database, {
        sessionId: "sub",
        at: early,
        scope: "subagent",
        parentSessionId: "s1",
      }).map((quest) => quest.questId),
    ).toEqual(["Q2"]);
    // Another parent's declarations are a different set.
    expect(
      activeDeclaredQuests(fixture.database, {
        sessionId: "sub",
        at: early,
        scope: "subagent",
        parentSessionId: "other",
      }),
    ).toEqual([]);
    expect(latestDeclaredParentSessionId(fixture.database, "sub", early)).toBe("s1");
    expect(latestDeclaredParentSessionId(fixture.database, "sub", "2026-09-04T13:00:00.000Z")).toBe(
      null,
    );
    expect(
      currentDeclaredQuestForSubagent(fixture.database, {
        sessionId: "sub",
        parentSessionId: "s1",
        at: early,
      })?.questId,
    ).toBe("Q2");
    expect(sessionHasActiveDeclaration(fixture.database, { sessionId: "sub", at: early })).toBe(
      true,
    );
    // A session-scope fold of the same session sees none of it.
    expect(activeIds(fixture, early, "sub")).toEqual([]);
  });

  test("a subagent's second declaration after its --done starts at the done", () => {
    const fixture = seed();
    const sub = { sessionId: "sub", parentSessionId: "s1" };
    declare(fixture, "2026-09-04T15:00:00.000Z", "Q2", sub);
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q2", { ...sub, done: true });
    declare(fixture, "2026-09-04T17:00:00.000Z", "Q3", sub);

    const at = (time: string) =>
      activeDeclaredQuests(fixture.database, {
        sessionId: "sub",
        at: time,
        scope: "subagent",
        parentSessionId: "s1",
      }).map((quest) => quest.questId);
    expect(at("2026-09-04T15:30:00.000Z")).toEqual(["Q2"]);
    expect(at("2026-09-04T16:30:00.000Z")).toEqual(["Q3"]);
  });
});

describe("quest declare --since", () => {
  function harness() {
    const fixture = seed();
    const lines: string[] = [];
    const context = {
      database: fixture.database,
      config: {} as never,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    };
    return {
      ...fixture,
      lines,
      run: (args: string[]) => runIntentCommand(args, context),
    };
  }

  test("stores the start on the event and the coverage follows it", async () => {
    const { database, run } = harness();
    const code = await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--quest",
      "Q1",
      "--at",
      "2026-09-04T16:00:00.000Z",
      "--since",
      "2026-09-04T15:30:00.000Z",
    ]);

    expect(code).toBe(0);
    const row = database
      .query("SELECT payload FROM events WHERE kind = 'quest.declared'")
      .get() as {
      payload: string;
    };
    expect(JSON.parse(row.payload).since).toBe("2026-09-04T15:30:00.000Z");
    expect(
      activeDeclaredQuests(database, { sessionId: "s1", at: "2026-09-04T15:00:00.000Z" }),
    ).toEqual([]);
    expect(
      activeDeclaredQuests(database, { sessionId: "s1", at: "2026-09-04T15:30:00.000Z" }),
    ).toHaveLength(1);
  });

  test("a --since after the declaration is a usage error and writes nothing", async () => {
    const { database, run } = harness();
    const code = await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--quest",
      "Q1",
      "--at",
      "2026-09-04T16:00:00.000Z",
      "--since",
      "2026-09-04T16:00:01.000Z",
    ]);

    expect(code).toBe(2);
    expect(
      (
        database
          .query("SELECT COUNT(*) AS count FROM events WHERE kind = 'quest.declared'")
          .get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  test("an unparseable --since and --since with --done are usage errors", async () => {
    const { run } = harness();
    expect(
      await run(["quest", "declare", "--session", "s1", "--quest", "Q1", "--since", "nonsense"]),
    ).toBe(2);
    await run(["quest", "declare", "--session", "s1", "--quest", "Q1"]);
    expect(
      await run([
        "quest",
        "declare",
        "--session",
        "s1",
        "--done",
        "Q1",
        "--since",
        "2026-09-04T15:00:00.000Z",
      ]),
    ).toBe(2);
  });
});

describe("w5_stale_windows is derived from declarations", () => {
  const staleRows = (fixture: Fixture) =>
    fixture.database
      .query(
        "SELECT session_id AS sessionId, from_ts AS fromTs, through_ts AS throughTs FROM w5_stale_windows ORDER BY through_ts",
      )
      .all() as { sessionId: string; fromTs: string | null; throughTs: string }[];

  test("a first declaration marks the session's start up to its event", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1");

    expect(staleRows(fixture)).toEqual([
      { sessionId: "s1", fromTs: null, throughTs: "2026-09-04T16:00:00.000Z" },
    ]);
    const marked = fixture.database
      .query("SELECT marked_at AS markedAt FROM w5_stale_windows")
      .get() as {
      markedAt: string;
    };
    const recorded = fixture.database
      .query("SELECT recorded_at AS recordedAt FROM events WHERE kind = 'quest.declared'")
      .get() as { recordedAt: string };
    expect(marked.markedAt).toBe(recorded.recordedAt);
  });

  test("an amendment, a declaration made while another is open, and --done mark nothing", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T15:00:00.000Z", "Q1");
    declare(fixture, "2026-09-04T15:30:00.000Z", "Q1", { plan: ["amended"] });
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q2");
    declare(fixture, "2026-09-04T16:30:00.000Z", "Q1", { done: true });

    expect(staleRows(fixture)).toEqual([
      { sessionId: "s1", fromTs: null, throughTs: "2026-09-04T15:00:00.000Z" },
    ]);
  });

  test("a declaration after every quest was ended marks from the last --done; --since marks from since", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T15:00:00.000Z", "Q1");
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1", { done: true });
    declare(fixture, "2026-09-04T17:00:00.000Z", "Q2");
    declare(fixture, "2026-09-04T18:00:00.000Z", "Q3", { since: "2026-09-04T17:30:00.000Z" });

    expect(staleRows(fixture)).toEqual([
      { sessionId: "s1", fromTs: null, throughTs: "2026-09-04T15:00:00.000Z" },
      {
        sessionId: "s1",
        fromTs: "2026-09-04T16:00:00.000Z",
        throughTs: "2026-09-04T17:00:00.000Z",
      },
      {
        sessionId: "s1",
        fromTs: "2026-09-04T17:30:00.000Z",
        throughTs: "2026-09-04T18:00:00.000Z",
      },
    ]);
  });

  test("a declaration that starts at its own instant marks nothing", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1", { since: "2026-09-04T16:00:00.000Z" });

    expect(staleRows(fixture)).toEqual([]);
  });

  test("a subagent's declaration marks the subagent's session", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q2", {
      sessionId: "sub",
      parentSessionId: "s1",
    });

    expect(staleRows(fixture)).toEqual([
      { sessionId: "sub", fromTs: null, throughTs: "2026-09-04T16:00:00.000Z" },
    ]);
  });

  test("a rebuild reproduces the same rows from the events alone", () => {
    const fixture = seed();
    declare(fixture, "2026-09-04T15:00:00.000Z", "Q1");
    declare(fixture, "2026-09-04T16:00:00.000Z", "Q1", { done: true });
    declare(fixture, "2026-09-04T17:00:00.000Z", "Q2");
    const dump = () =>
      fixture.database
        .query("SELECT * FROM w5_stale_windows ORDER BY through_ts, session_id")
        .all();
    const before = dump();
    expect(before).toHaveLength(2);

    rebuildAll(fixture.database);

    expect(dump()).toEqual(before);
  });
});
