import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { openStint, recordTrace } from "../../src/intent/api";
import type { W5Config } from "../../src/intent/config";
import { declareQuest } from "../../src/intent/declarations";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { backfill, planBackfillWindows, selectBackfillSessions } from "../../src/w5/backfill";
import type { Classifier, ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";
import { replaceStaleWindow } from "../../src/w5/stale";

registerAllProjections();

const config: W5Config = {
  model: "m",
  throttleMinutes: 10,
  watchTurns: 3,
  askMinStintMinutes: 20,
  askBudgetMinutes: 30,
  askExpireTurns: 2,
  backfillDays: 3650,
  backend: "claude-cli",
  claudeCommand: "claude",
  timeoutSeconds: 180,
  stintIdleMinutes: 45,
  memoryHours: 8,
  memoryStints: 10,
  memoryQuests: 20,
  overlapMessages: 3,
  mode: "declared",
  inferenceFallback: true,
  stintMinMinutes: 5,
};

const homeConfig: Config = {
  mondayApiToken: "t",
  mondayUser: "u",
  ghUser: "u",
  ghOrgs: [],
  ghIncludePersonal: false,
  ghToken: undefined,
  gitAuthorEmails: [],
  claudeDirs: [],
  hostSlug: "host",
  tz: "UTC",
  since: "2020-01-01",
  syncToken: "unused",
  home: "/tmp",
};

/** Declared-mode answer when Q1 is offered, an unquested stretch otherwise. */
class RecordingClassifier implements Classifier {
  public windows: ClassifierWindow[] = [];
  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    this.windows.push(window);
    const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
    const last = window.messages.at(-1)?.ts ?? first;
    const declared =
      window.mode === "declared" && Object.keys(window.activeQuestAliases).length > 0;
    return {
      segments: [
        {
          startedAt: first,
          endedAt: last,
          what: "work",
          why: "ship",
          belongs: true,
          guess: null,
          quest: declared ? "Q1" : null,
          stint: "new: work",
          matchedQuest: null,
          proposedQuest: null,
          matchedStint: null,
          continuesStint: null,
          newStintReason: "first work of the window",
          isSwitch: false,
          trigger: null,
          confidence: 0.9,
          questions: [],
        },
      ],
      sessionNote: null,
    } as unknown as ClassifierResult;
  }
}

function seed() {
  const database = openDatabase(":memory:");
  ensureTables(database);
  const store = new EventStore(database);
  applyIncremental(
    database,
    store.append({ actor: "hero", kind: "hero.created", subject: "H1", payload: { name: "S" } }),
  );
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 't', 'main',
               '2026-09-04T14:00:00.000Z', '2026-09-04T15:00:00.000Z', 3, 0, '[]', 'host', '2026-09-04T15:00:00.000Z')`,
    )
    .run();
  // Two windows (the gap exceeds backfillWindowMinutes = 30).
  for (const [index, ts] of [
    "2026-09-04T14:00:00.000Z",
    "2026-09-04T14:10:00.000Z",
    "2026-09-04T15:00:00.000Z",
  ].entries()) {
    database
      .query(
        "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES (?, 's1', ?, 'user', 0, 'work')",
      )
      .run(`m${index}`, ts);
  }
  return { database, store };
}

function createQuest(
  { database, store }: ReturnType<typeof seed>,
  id: string,
  extra: { confirmed?: boolean; originKind?: string } = {},
) {
  applyIncremental(
    database,
    store.append({
      actor: "hero",
      kind: "quest.created",
      subject: id,
      payload: {
        owner: { kind: "hero", id: "H1" },
        title: `Quest ${id}`,
        confirmed: extra.confirmed ?? true,
        origin_kind: extra.originKind ?? "declared",
      },
    }),
  );
}

function declareLate({ database, store }: ReturnType<typeof seed>, questId = "Q1") {
  declareQuest(store, database, {
    sessionId: "s1",
    questId,
    plan: [],
    scope: "session",
    declaredBy: "agent",
    at: "2026-09-04T16:00:00.000Z",
    heroId: "H1",
  });
}

const FIRST_RUN = "2026-09-04T17:00:00.000Z";

/** A pass that starts after the declaration was recorded (the real clock plus a margin, so a fast test never ties). */
const afterDeclaration = () => new Date(Date.now() + 5000).toISOString();

async function run(
  database: ReturnType<typeof openDatabase>,
  classifier: Classifier,
  now: string,
  logs: string[] = [],
) {
  return backfill(database, homeConfig, config, classifier, {
    days: 3650,
    now,
    log: (line) => logs.push(line),
  });
}

const plan = (database: ReturnType<typeof openDatabase>) =>
  planBackfillWindows(database, selectBackfillSessions(database, { cutoff: "2020-01-01" }), {
    windowMinutes: 30,
  });

describe("planBackfillWindows marks a window stale when a later declaration covers it", () => {
  test("windows classified before a first declaration are stale; windows classified after it are not", async () => {
    const fixture = seed();
    createQuest(fixture, "Q1");
    await run(fixture.database, new RecordingClassifier(), FIRST_RUN);
    expect(plan(fixture.database).map((window) => [window.covered, window.stale])).toEqual([
      [true, false],
      [true, false],
    ]);

    declareLate(fixture);

    expect(plan(fixture.database).map((window) => [window.covered, window.stale])).toEqual([
      [false, true],
      [false, true],
    ]);
    // The same plan once a pass newer than the declaration has classified them.
    await run(fixture.database, new RecordingClassifier(), afterDeclaration());
    expect(plan(fixture.database).map((window) => [window.covered, window.stale])).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  test("a window covered only by a live trace (no w5_windows row) is stale when the trace predates the declaration", () => {
    const fixture = seed();
    createQuest(fixture, "Q1");
    const stint = openStint(fixture.store, fixture.database, {
      outcome: "work",
      actor: "hook",
      at: "2026-09-04T14:00:00.000Z",
    });
    recordTrace(fixture.store, fixture.database, {
      stint,
      tool: "claude",
      place: "p",
      source: "claude",
      startedAt: "2026-09-04T14:00:00.000Z",
      endedAt: "2026-09-04T14:10:00.000Z",
      who: "s",
      what: "work",
      why: "ship",
      where: "p",
      how: "claude",
      confidence: 0.9,
      classifiedBy: "assistant",
      actor: "hook",
      sessionId: "s1",
    });
    expect(plan(fixture.database)[0]?.covered).toBe(true);

    declareLate(fixture);

    expect(plan(fixture.database)[0]).toMatchObject({ covered: false, stale: true });
  });

  test("a window that ends before the coverage's explicit start stays covered", async () => {
    const fixture = seed();
    createQuest(fixture, "Q1");
    await run(fixture.database, new RecordingClassifier(), FIRST_RUN);
    declareQuest(fixture.store, fixture.database, {
      sessionId: "s1",
      questId: "Q1",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T16:00:00.000Z",
      since: "2026-09-04T14:30:00.000Z",
      heroId: "H1",
    });

    expect(plan(fixture.database).map((window) => [window.covered, window.stale])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  test("a window that starts after the declaration's own instant is not stale", async () => {
    const fixture = seed();
    createQuest(fixture, "Q1");
    await run(fixture.database, new RecordingClassifier(), FIRST_RUN);
    declareQuest(fixture.store, fixture.database, {
      sessionId: "s1",
      questId: "Q1",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T14:30:00.000Z",
      heroId: "H1",
    });

    expect(plan(fixture.database).map((window) => [window.covered, window.stale])).toEqual([
      [false, true],
      [true, false],
    ]);
  });

  test("a session in inferred mode has no stale windows", async () => {
    const fixture = seed();
    createQuest(fixture, "Q1");
    await run(fixture.database, new RecordingClassifier(), FIRST_RUN);
    declareLate(fixture);

    const planned = planBackfillWindows(
      fixture.database,
      selectBackfillSessions(fixture.database, { cutoff: "2020-01-01" }),
      { windowMinutes: 30, staleEligible: () => false },
    );

    expect(planned.map((window) => [window.covered, window.stale])).toEqual([
      [true, false],
      [true, false],
    ]);
  });
});

describe("backfill replaces a stale window once", () => {
  test("re-classifies in declared mode with the quest offered, and retracts what the first pass recorded", async () => {
    const fixture = seed();
    createQuest(fixture, "Q1");
    const first = new RecordingClassifier();
    await run(fixture.database, first, FIRST_RUN);
    // No declaration yet: the fallback ran them in inferred mode, no quest.
    expect(first.windows.map((window) => window.mode)).toEqual(["inferred", "inferred"]);
    const firstTraces = fixture.database
      .query("SELECT id FROM traces WHERE retracted_at IS NULL")
      .all() as { id: string }[];
    expect(firstTraces).toHaveLength(2);

    declareLate(fixture);
    const second = new RecordingClassifier();
    const logs: string[] = [];
    const result = await run(fixture.database, second, afterDeclaration(), logs);

    expect(result.windowsClassified).toBe(2);
    expect(second.windows.map((window) => window.mode)).toEqual(["declared", "declared"]);
    expect(second.windows.every((window) => window.activeQuests.length === 1)).toBe(true);
    // The first pass's output is gone from every view; the second pass's replaces it.
    const live = fixture.database
      .query(
        `SELECT traces.id, stints.quest_id AS questId FROM traces
           JOIN stints ON stints.id = traces.stint_id
          WHERE traces.retracted_at IS NULL`,
      )
      .all() as { id: string; questId: string | null }[];
    expect(live).toHaveLength(2);
    expect(live.every((trace) => trace.questId === "Q1")).toBe(true);
    expect(live.some((trace) => firstTraces.some((old) => old.id === trace.id))).toBe(false);
    const retractedStints = fixture.database
      .query("SELECT COUNT(*) AS count FROM stints WHERE retracted_at IS NOT NULL")
      .get() as { count: number };
    expect(retractedStints.count).toBe(2);
    // One line per replaced window.
    expect(logs.filter((line) => line.includes("backfill: replaced s1 window"))).toHaveLength(2);

    // And never again: a third pass finds nothing stale.
    const third = new RecordingClassifier();
    const thirdResult = await run(fixture.database, third, afterDeclaration());
    expect(third.windows).toHaveLength(0);
    expect(thirdResult.windowsClassified).toBe(0);
  });

  test("a window no declaration reaches is left alone", async () => {
    const fixture = seed();
    createQuest(fixture, "Q1");
    await run(fixture.database, new RecordingClassifier(), FIRST_RUN);
    declareQuest(fixture.store, fixture.database, {
      sessionId: "s1",
      questId: "Q1",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T16:00:00.000Z",
      since: "2026-09-04T14:30:00.000Z",
      heroId: "H1",
    });
    const second = new RecordingClassifier();

    await run(fixture.database, second, afterDeclaration());

    expect(second.windows).toHaveLength(1);
    expect(second.windows[0]?.messages.map((message) => message.ts)).toEqual([
      "2026-09-04T15:00:00.000Z",
    ]);
    expect(
      (
        fixture.database
          .query("SELECT COUNT(*) AS count FROM traces WHERE retracted_at IS NOT NULL")
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });
});

describe("replaceStaleWindow protects stints that already carry a quest", () => {
  function stintWithTrace(
    fixture: ReturnType<typeof seed>,
    outcome: string,
    quest: string | undefined,
    startedAt = "2026-09-04T14:00:00.000Z",
    endedAt = "2026-09-04T14:10:00.000Z",
  ) {
    const stint = openStint(fixture.store, fixture.database, {
      quest,
      outcome,
      actor: "hook",
      at: startedAt,
    });
    const trace = recordTrace(fixture.store, fixture.database, {
      stint,
      tool: "claude",
      place: "p",
      source: "claude",
      startedAt,
      endedAt,
      who: "s",
      what: outcome,
      why: "ship",
      where: "p",
      how: "claude",
      confidence: 0.9,
      classifiedBy: "assistant",
      actor: "hook",
      sessionId: "s1",
    });
    return { stint, trace };
  }

  test("replaces unquested and inferred-unconfirmed stints, keeps declared and confirmed ones", () => {
    const fixture = seed();
    createQuest(fixture, "QI", { confirmed: false, originKind: "inferred" });
    createQuest(fixture, "QD", { confirmed: false, originKind: "declared" });
    createQuest(fixture, "QC", { confirmed: true, originKind: "inferred" });
    const loose = stintWithTrace(fixture, "loose", undefined);
    const inferred = stintWithTrace(fixture, "inferred", "QI");
    const declared = stintWithTrace(fixture, "declared", "QD");
    const confirmed = stintWithTrace(fixture, "confirmed", "QC");

    const replaced = replaceStaleWindow(fixture.database, {
      sessionId: "s1",
      startedAt: "2026-09-04T14:00:00.000Z",
      endedAt: "2026-09-04T14:10:00.000Z",
    });

    expect(replaced).toEqual({ traces: 2, stints: 2, quests: 1, kept: 2 });
    const retracted = (table: string, id: string) =>
      (
        fixture.database.query(`SELECT retracted_at FROM ${table} WHERE id = ?`).get(id) as {
          retracted_at: string | null;
        }
      ).retracted_at !== null;
    expect(retracted("traces", loose.trace)).toBe(true);
    expect(retracted("traces", inferred.trace)).toBe(true);
    expect(retracted("stints", inferred.stint)).toBe(true);
    expect(retracted("quests", "QI")).toBe(true);
    expect(retracted("traces", declared.trace)).toBe(false);
    expect(retracted("stints", declared.stint)).toBe(false);
    expect(retracted("quests", "QD")).toBe(false);
    expect(retracted("traces", confirmed.trace)).toBe(false);
    expect(retracted("quests", "QC")).toBe(false);
  });

  test("touches only the one session's traces nested in the window, and leaves the session's other windows alone", async () => {
    const fixture = seed();
    createQuest(fixture, "Q1");
    await run(fixture.database, new RecordingClassifier(), FIRST_RUN);
    const windowsBefore = fixture.database
      .query("SELECT COUNT(*) AS count FROM w5_windows")
      .get() as { count: number };
    const outside = stintWithTrace(
      fixture,
      "outside",
      undefined,
      "2026-09-04T16:00:00.000Z",
      "2026-09-04T16:10:00.000Z",
    );

    const replaced = replaceStaleWindow(fixture.database, {
      sessionId: "s1",
      startedAt: "2026-09-04T14:00:00.000Z",
      endedAt: "2026-09-04T14:10:00.000Z",
    });

    expect(replaced.traces).toBe(1);
    expect(
      (
        fixture.database
          .query("SELECT retracted_at FROM traces WHERE id = ?")
          .get(outside.trace) as { retracted_at: string | null }
      ).retracted_at,
    ).toBeNull();
    // Unlike a reset on a throwaway copy, the session's coverage rows stay.
    expect(
      (
        fixture.database.query("SELECT COUNT(*) AS count FROM w5_windows").get() as {
          count: number;
        }
      ).count,
    ).toBe(windowsBefore.count);
    expect(
      replaceStaleWindow(fixture.database, {
        sessionId: "other",
        startedAt: "2026-09-04T14:00:00.000Z",
        endedAt: "2026-09-04T14:10:00.000Z",
      }),
    ).toEqual({ traces: 0, stints: 0, quests: 0, kept: 0 });
  });
});
