import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import type { W5Config } from "../../src/intent/config";
import { declareQuest } from "../../src/intent/declarations";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { advanceQuestions } from "../../src/w5/questions";

registerAllProjections();

const config: W5Config = {
  model: "m",
  throttleMinutes: 10,
  watchTurns: 3,
  askMinStintMinutes: 20,
  askBudgetMinutes: 30,
  askExpireTurns: 2,
  backfillDays: 15,
  backend: "claude-cli",
  claudeCommand: "claude",
  timeoutSeconds: 180,
  stintIdleMinutes: 45,
  memoryHours: 8,
  memoryStints: 10,
  overlapMessages: 3,
  mode: "declared",
  inferenceFallback: true,
  stintMinMinutes: 5,
};

function seedStintAndTrace(
  database: ReturnType<typeof openDatabase>,
  input: { stintId: string; questId: string | null; sessionId: string; isSwitch: boolean },
): string {
  database
    .query(
      "INSERT OR IGNORE INTO stints (id, quest_id, outcome, opened_at, revision) VALUES (?, ?, 'outcome', '2026-09-04T14:00:00.000Z', 1)",
    )
    .run(input.stintId, input.questId);
  const traceId = newUlid();
  database
    .query(
      `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES (?, ?, 'claude-code', 'p', 'session', '2026-09-04T15:00:00.000Z', '2026-09-04T15:20:00.000Z', 'hero', 'what', 'why', 'p', 'claude-code', 0.6, 'assistant', ?, '2026-09-04T15:20:00.000Z')`,
    )
    .run(traceId, input.stintId, input.sessionId);
  return traceId;
}

function seedQuestion(
  database: ReturnType<typeof openDatabase>,
  store: EventStore,
  input: { traceId: string; sessionId: string; kind: string; isSwitch?: boolean },
): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: "hook",
      kind: "question.asked",
      subject: id,
      sessionId: input.sessionId,
      payload: {
        trace: input.traceId,
        kind: input.kind,
        text: input.kind,
        is_switch: input.isSwitch ?? false,
      },
    }),
  );
  return id;
}

describe("advanceQuestions", () => {
  test("watching gains turns but does not ask before watchTurns", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedStintAndTrace(database, {
      stintId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    seedQuestion(database, store, {
      traceId,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 2,
      sessionStintMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.asked).toHaveLength(0);
    const row = database.query("SELECT turns_watched, state FROM questions").get() as {
      turns_watched: number;
      state: string;
    };
    expect(row.turns_watched).toBe(2);
    expect(row.state).toBe("watching");
  });

  test("asks a which_quest question on a switch once watchTurns reached", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedStintAndTrace(database, {
      stintId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    const questionId = seedQuestion(database, store, {
      traceId,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionStintMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.asked.map((q) => q.id)).toEqual([questionId]);
    const row = database.query("SELECT state, turns_at_ask FROM questions").get() as {
      state: string;
      turns_at_ask: number;
    };
    expect(row.state).toBe("asked");
    expect(row.turns_at_ask).toBe(3);
  });

  test("never asks a why question on a stint that has a quest; it expires to review", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedStintAndTrace(database, {
      stintId: "A1",
      questId: "Q1",
      sessionId: "s1",
      isSwitch: false,
    });
    seedQuestion(database, store, { traceId, sessionId: "s1", kind: "why" });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionStintMinutes: 25,
      resolvedByContext: [],
    });

    expect(result.asked).toHaveLength(0);
    expect(result.expired).toHaveLength(1);
    const row = database.query("SELECT state FROM questions").get() as { state: string };
    expect(row.state).toBe("expired");
  });

  test("budget: no second ask within askBudgetMinutes of a prior ask in the same session", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceA = seedStintAndTrace(database, {
      stintId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    const firstQuestion = seedQuestion(database, store, {
      traceId: traceA,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });
    advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionStintMinutes: 5,
      resolvedByContext: [],
    });
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "question.answered",
        subject: firstQuestion,
        at: "2026-09-04T15:22:00.000Z",
        payload: { quest: "Q1", answeredBy: "hero" },
      }),
    );

    const traceB = seedStintAndTrace(database, {
      stintId: "A2",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    seedQuestion(database, store, {
      traceId: traceB,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:40:00.000Z",
      turnsSinceLastRun: 3,
      sessionStintMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.asked).toHaveLength(0);
  });

  test("no two asked in a row: an unanswered asked question blocks the next ask", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceA = seedStintAndTrace(database, {
      stintId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    seedQuestion(database, store, {
      traceId: traceA,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });
    advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionStintMinutes: 5,
      resolvedByContext: [],
    });

    const traceB = seedStintAndTrace(database, {
      stintId: "A2",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    seedQuestion(database, store, {
      traceId: traceB,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:22:00.000Z",
      turnsSinceLastRun: 3,
      sessionStintMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.asked).toHaveLength(0);
  });

  test("quiet suppresses asking until w5_quiet.until passes", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    database.query("INSERT INTO w5_quiet (until) VALUES ('2026-09-04T16:00:00.000Z')").run();
    const traceId = seedStintAndTrace(database, {
      stintId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    seedQuestion(database, store, {
      traceId,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionStintMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.asked).toHaveLength(0);
  });

  test("expiry: an asked question past askExpireTurns expires", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedStintAndTrace(database, {
      stintId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    const questionId = seedQuestion(database, store, {
      traceId,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });
    advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 3,
      sessionStintMinutes: 5,
      resolvedByContext: [],
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:25:00.000Z",
      turnsSinceLastRun: 2,
      sessionStintMinutes: 5,
      resolvedByContext: [],
    });

    expect(result.expired.map((q) => q.id)).toEqual([questionId]);
    const row = database.query("SELECT state FROM questions").get() as { state: string };
    expect(row.state).toBe("expired");
  });

  test("resolvedByContext resolves a watching question without asking it", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedStintAndTrace(database, {
      stintId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: true,
    });
    const questionId = seedQuestion(database, store, {
      traceId,
      sessionId: "s1",
      kind: "which_quest",
      isSwitch: true,
    });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:21:00.000Z",
      turnsSinceLastRun: 1,
      sessionStintMinutes: 5,
      resolvedByContext: [questionId],
    });

    expect(result.resolved.map((q) => q.id)).toEqual([questionId]);
    const row = database.query("SELECT state, answered_by FROM questions").get() as {
      state: string;
      answered_by: string;
    };
    expect(row.state).toBe("resolved_by_context");
    expect(row.answered_by).toBe("context");
  });
});

test("advanceQuestions transitions are event-sourced: tempad rebuild reproduces the questions table exactly", () => {
  const database = openDatabase(":memory:");
  ensureTables(database);
  const store = new EventStore(database);

  // Question 1: watched, then promoted to asked (which_quest + isSwitch).
  const traceA = seedStintAndTrace(database, {
    stintId: "A1",
    questId: null,
    sessionId: "s1",
    isSwitch: true,
  });
  const promotedQuestion = seedQuestion(database, store, {
    traceId: traceA,
    sessionId: "s1",
    kind: "which_quest",
    isSwitch: true,
  });
  advanceQuestions(store, database, config, {
    sessionId: "s1",
    now: "2026-09-04T15:21:00.000Z",
    turnsSinceLastRun: 3,
    sessionStintMinutes: 5,
    resolvedByContext: [],
  });

  // Question 2 (different session): watched once, not yet promoted.
  const traceB = seedStintAndTrace(database, {
    stintId: "A2",
    questId: null,
    sessionId: "s2",
    isSwitch: false,
  });
  const watchedQuestion = seedQuestion(database, store, {
    traceId: traceB,
    sessionId: "s2",
    kind: "which_quest",
    isSwitch: false,
  });
  advanceQuestions(store, database, config, {
    sessionId: "s2",
    now: "2026-09-04T15:21:00.000Z",
    turnsSinceLastRun: 1,
    sessionStintMinutes: 5,
    resolvedByContext: [],
  });

  // Question 3: why-kind on a stint that already has a quest -> auto-expires.
  const traceC = seedStintAndTrace(database, {
    stintId: "A3",
    questId: "Q1",
    sessionId: "s3",
    isSwitch: false,
  });
  seedQuestion(database, store, { traceId: traceC, sessionId: "s3", kind: "why" });
  advanceQuestions(store, database, config, {
    sessionId: "s3",
    now: "2026-09-04T15:21:00.000Z",
    turnsSinceLastRun: 1,
    sessionStintMinutes: 5,
    resolvedByContext: [],
  });

  // Question 4: resolved by context.
  const traceD = seedStintAndTrace(database, {
    stintId: "A4",
    questId: null,
    sessionId: "s4",
    isSwitch: true,
  });
  const resolvedQuestion = seedQuestion(database, store, {
    traceId: traceD,
    sessionId: "s4",
    kind: "which_quest",
    isSwitch: true,
  });
  advanceQuestions(store, database, config, {
    sessionId: "s4",
    now: "2026-09-04T15:21:00.000Z",
    turnsSinceLastRun: 1,
    sessionStintMinutes: 5,
    resolvedByContext: [resolvedQuestion],
  });

  // Advance the promoted question further so it expires too (askExpireTurns: 2).
  advanceQuestions(store, database, config, {
    sessionId: "s1",
    now: "2026-09-04T15:25:00.000Z",
    turnsSinceLastRun: 2,
    sessionStintMinutes: 5,
    resolvedByContext: [],
  });

  const before = database
    .query(
      "SELECT id, trace_id, session_id, text, kind, state, asked_at, answered_at, answer, answered_by, turns_watched, turns_at_ask, is_switch FROM questions ORDER BY id",
    )
    .all();
  expect(before).toHaveLength(4);

  const stateNames = new Map(
    (before as { id: string; state: string }[]).map((row) => [row.id, row.state]),
  );
  expect(stateNames.get(promotedQuestion)).toBe("expired");
  expect(stateNames.get(watchedQuestion)).toBe("watching");
  expect(stateNames.get(resolvedQuestion)).toBe("resolved_by_context");

  rebuildAll(database);

  const after = database
    .query(
      "SELECT id, trace_id, session_id, text, kind, state, asked_at, answered_at, answer, answered_by, turns_watched, turns_at_ask, is_switch FROM questions ORDER BY id",
    )
    .all();

  expect(after).toEqual(before);
});

describe("advanceQuestions and the verifier's question kinds", () => {
  /**
   * The declared-mode shape: the stint carries the declared quest, so the
   * inference-era "no quest" heuristic can never fire for these questions.
   */
  function seedDeclaredQuestion(kind: "belongs" | "declare") {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedStintAndTrace(database, {
      stintId: "A1",
      questId: "Q1",
      sessionId: "s1",
      isSwitch: false,
    });
    const questionId = seedQuestion(database, store, { traceId, sessionId: "s1", kind });
    return { database, store, questionId };
  }

  for (const kind of ["belongs", "declare"] as const) {
    test(`a ${kind} question watches, then is asked once watchTurns is reached`, () => {
      const { database, store, questionId } = seedDeclaredQuestion(kind);

      // Below watchTurns: still watching.
      const early = advanceQuestions(store, database, config, {
        sessionId: "s1",
        now: "2026-09-04T15:30:00.000Z",
        turnsSinceLastRun: 1,
        // Deliberately below askMinActivityMinutes: these kinds must not depend
        // on the stint heuristic at all.
        sessionStintMinutes: 0,
        resolvedByContext: [],
      });
      expect(early.asked).toHaveLength(0);
      expect(
        (
          database.query("SELECT state FROM questions WHERE id = ?").get(questionId) as {
            state: string;
          }
        ).state,
      ).toBe("watching");

      const later = advanceQuestions(store, database, config, {
        sessionId: "s1",
        now: "2026-09-04T15:40:00.000Z",
        turnsSinceLastRun: 3,
        sessionStintMinutes: 0,
        resolvedByContext: [],
      });

      expect(later.asked.map((question) => question.id)).toEqual([questionId]);
      expect(
        (
          database.query("SELECT state FROM questions WHERE id = ?").get(questionId) as {
            state: string;
          }
        ).state,
      ).toBe("asked");
    });

    test(`an asked ${kind} question expires after askExpireTurns`, () => {
      const { database, store, questionId } = seedDeclaredQuestion(kind);

      advanceQuestions(store, database, config, {
        sessionId: "s1",
        now: "2026-09-04T15:40:00.000Z",
        turnsSinceLastRun: 3,
        sessionStintMinutes: 0,
        resolvedByContext: [],
      });

      const expiring = advanceQuestions(store, database, config, {
        sessionId: "s1",
        now: "2026-09-04T16:40:00.000Z",
        turnsSinceLastRun: 2,
        sessionStintMinutes: 0,
        resolvedByContext: [],
      });

      expect(expiring.expired.map((question) => question.id)).toEqual([questionId]);
      expect(
        (
          database.query("SELECT state FROM questions WHERE id = ?").get(questionId) as {
            state: string;
          }
        ).state,
      ).toBe("expired");
    });
  }

  test("a belongs question on a stint that has a quest is still asked", () => {
    // The regression this guards: the promotion gate used to require a null
    // quest, which declared mode never produces, so belongs questions sat in
    // `watching` forever -- never asked, never expired.
    const { database, store, questionId } = seedDeclaredQuestion("belongs");

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:40:00.000Z",
      turnsSinceLastRun: 3,
      sessionStintMinutes: 0,
      resolvedByContext: [],
    });

    expect(result.asked.map((question) => question.id)).toEqual([questionId]);
    const quest = database
      .query("SELECT quest_id as questId FROM stints WHERE id = 'A1'")
      .get() as { questId: string | null };
    expect(quest.questId).toBe("Q1");
  });

  test("the ask budget and quiet window still gate the new kinds", () => {
    const { database, store, questionId } = seedDeclaredQuestion("belongs");
    database.query("INSERT INTO w5_quiet (until) VALUES ('2026-09-04T18:00:00.000Z')").run();

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:40:00.000Z",
      turnsSinceLastRun: 3,
      sessionStintMinutes: 0,
      resolvedByContext: [],
    });

    expect(result.asked).toHaveLength(0);
    expect(
      (
        database.query("SELECT state FROM questions WHERE id = ?").get(questionId) as {
          state: string;
        }
      ).state,
    ).toBe("watching");
  });
});

describe("advanceQuestions and dismissed stints", () => {
  test("advanceQuestions expires a watching belongs question on a stint that has been dismissed", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedStintAndTrace(database, {
      stintId: "A1",
      questId: "Q1",
      sessionId: "s1",
      isSwitch: false,
    });
    const questionId = seedQuestion(database, store, { traceId, sessionId: "s1", kind: "belongs" });
    applyIncremental(
      database,
      store.append({
        actor: "system",
        kind: "stint.dismissed",
        subject: "A1",
        payload: { reason: "below minimum" },
      }),
    );

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:40:00.000Z",
      turnsSinceLastRun: 1,
      sessionStintMinutes: 0,
      resolvedByContext: [],
    });

    expect(result.expired.map((q) => q.id)).toContain(questionId);
    expect(result.asked.map((q) => q.id)).not.toContain(questionId);
    const question = database.query("SELECT state FROM questions WHERE id = ?").get(questionId) as {
      state: string;
    };
    expect(question.state).toBe("expired");
  });

  test("advanceQuestions still promotes a belongs question when its stint is not dismissed", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const traceId = seedStintAndTrace(database, {
      stintId: "A1",
      questId: "Q1",
      sessionId: "s1",
      isSwitch: false,
    });
    const questionId = seedQuestion(database, store, { traceId, sessionId: "s1", kind: "belongs" });

    const result = advanceQuestions(store, database, config, {
      sessionId: "s1",
      now: "2026-09-04T15:40:00.000Z",
      turnsSinceLastRun: 3,
      sessionStintMinutes: 0,
      resolvedByContext: [],
    });

    expect(result.asked.map((q) => q.id)).toEqual([questionId]);
    expect(result.expired.map((q) => q.id)).not.toContain(questionId);
  });
});

describe("advanceQuestions and a session that has declared since the question was queued", () => {
  const advance = (
    database: ReturnType<typeof openDatabase>,
    store: EventStore,
    now: string,
    turnsSinceLastRun: number,
  ) =>
    advanceQuestions(store, database, config, {
      sessionId: "s1",
      now,
      turnsSinceLastRun,
      sessionStintMinutes: 0,
      resolvedByContext: [],
    });

  function seed() {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: heroId,
        payload: { name: "S" },
      }),
    );
    const traceId = seedStintAndTrace(database, {
      stintId: "A1",
      questId: null,
      sessionId: "s1",
      isSwitch: false,
    });
    const questionId = seedQuestion(database, store, { traceId, sessionId: "s1", kind: "declare" });
    const stateOf = () =>
      (
        database.query("SELECT state FROM questions WHERE id = ?").get(questionId) as {
          state: string;
        }
      ).state;
    // The session's first declaration (`--new`), then the agent re-declaring the
    // same quest (`--quest <id> --by agent`), the shape the live session left.
    const declareInSession = (at: string) => {
      const first = declareQuest(store, database, {
        sessionId: "s1",
        newQuest: { title: "Ship X", outcome: "ship it", commitment: "personal" },
        plan: ["do it"],
        scope: "session",
        declaredBy: "hero",
        at,
        heroId,
      });
      declareQuest(store, database, {
        sessionId: "s1",
        questId: first.questId,
        plan: [],
        scope: "session",
        declaredBy: "agent",
        at: new Date(Date.parse(at) + 60_000).toISOString(),
        heroId,
      });
      return first.questId;
    };
    return { database, store, heroId, questionId, stateOf, declareInSession };
  }

  test("a watching declare question is resolved, not asked, once the session declared a quest", () => {
    const { database, store, questionId, stateOf, declareInSession } = seed();
    declareInSession("2026-09-04T15:25:00.000Z");

    const result = advance(database, store, "2026-09-04T15:40:00.000Z", 3);

    expect(result.asked).toHaveLength(0);
    expect(result.resolved.map((question) => question.id)).toEqual([questionId]);
    expect(stateOf()).toBe("resolved_by_context");
  });

  test("an already asked declare question is resolved once the session declares", () => {
    const { database, store, stateOf, declareInSession } = seed();
    expect(advance(database, store, "2026-09-04T15:40:00.000Z", 3).asked).toHaveLength(1);
    expect(stateOf()).toBe("asked");

    declareInSession("2026-09-04T15:45:00.000Z");
    advance(database, store, "2026-09-04T15:50:00.000Z", 1);

    expect(stateOf()).toBe("resolved_by_context");
  });

  test("a declare question survives when the only declared quest has been ended", () => {
    const { database, store, heroId, questionId, stateOf, declareInSession } = seed();
    const questId = declareInSession("2026-09-04T15:25:00.000Z");
    declareQuest(store, database, {
      sessionId: "s1",
      questId,
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T15:30:00.000Z",
      heroId,
      done: true,
    });

    const result = advance(database, store, "2026-09-04T15:40:00.000Z", 3);

    expect(result.asked.map((question) => question.id)).toEqual([questionId]);
    expect(stateOf()).toBe("asked");
  });

  test("a declare question survives when the only declared quest was retracted", () => {
    const { database, store, questionId, stateOf, declareInSession } = seed();
    const questId = declareInSession("2026-09-04T15:25:00.000Z");
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "retracted",
        subject: questId,
        at: "2026-09-04T15:30:00.000Z",
        payload: { retracts: "x", reason: "mistake" },
      }),
    );

    const result = advance(database, store, "2026-09-04T15:40:00.000Z", 3);

    expect(result.asked.map((question) => question.id)).toEqual([questionId]);
    expect(stateOf()).toBe("asked");
  });

  test("a subagent's declaration (--parent) resolves its declare question, never promoting it", () => {
    const { database, store, heroId, questionId, stateOf } = seed();
    declareQuest(store, database, {
      sessionId: "s1",
      parentSessionId: "parent",
      newQuest: { title: "Sub errand", outcome: "o", commitment: "personal" },
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-04T15:25:00.000Z",
      heroId,
    });

    const result = advance(database, store, "2026-09-04T15:40:00.000Z", 3);

    expect(result.asked).toHaveLength(0);
    expect(result.resolved.map((question) => question.id)).toEqual([questionId]);
    expect(stateOf()).toBe("resolved_by_context");
  });

  test("a subagent whose parent has an active quest resolves its declare question", () => {
    const { database, store, heroId, stateOf } = seed();
    const parent = declareQuest(store, database, {
      sessionId: "parent",
      newQuest: { title: "Parent quest", outcome: "o", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "hero",
      at: "2026-09-04T15:20:00.000Z",
      heroId,
    });
    // The subagent declared the parent's quest as its own, then ended it.
    declareQuest(store, database, {
      sessionId: "s1",
      parentSessionId: "parent",
      questId: parent.questId,
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-04T15:25:00.000Z",
      heroId,
    });
    declareQuest(store, database, {
      sessionId: "s1",
      parentSessionId: "parent",
      questId: parent.questId,
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-04T15:26:00.000Z",
      heroId,
      done: true,
    });

    // The window resolves a subagent through its parent's active quests too, so a
    // declare question is not needed while the parent has one.
    advance(database, store, "2026-09-04T15:40:00.000Z", 3);

    expect(stateOf()).toBe("resolved_by_context");
  });

  test("a declaration in another session does not resolve the question", () => {
    const { database, store, heroId, questionId, stateOf } = seed();
    declareQuest(store, database, {
      sessionId: "other",
      newQuest: { title: "Elsewhere", outcome: "o", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "hero",
      at: "2026-09-04T15:25:00.000Z",
      heroId,
    });

    const result = advance(database, store, "2026-09-04T15:40:00.000Z", 3);

    expect(result.asked.map((question) => question.id)).toEqual([questionId]);
    expect(stateOf()).toBe("asked");
  });

  test("belongs questions are untouched by a declaration", () => {
    const { database, store, declareInSession } = seed();
    const traceId = seedStintAndTrace(database, {
      stintId: "A2",
      questId: "Q1",
      sessionId: "s1",
      isSwitch: false,
    });
    const belongsId = seedQuestion(database, store, { traceId, sessionId: "s1", kind: "belongs" });
    declareInSession("2026-09-04T15:25:00.000Z");

    const result = advance(database, store, "2026-09-04T15:40:00.000Z", 3);

    expect(result.asked.map((question) => question.id)).toContain(belongsId);
  });
});
