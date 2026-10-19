import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig, type W5Config } from "../../src/intent/config";
import { declareQuest } from "../../src/intent/declarations";
import { rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { applyResult } from "../../src/w5/apply";
import {
  type ClassifierSegment,
  type ClassifierWindow,
  QUEST_NOT_NAMED_GUESS,
  UNRECOGNIZED_QUEST_ALIAS_GUESS,
  validateResult,
} from "../../src/w5/classifier";
import { runReviewCommand } from "../../src/w5/cli";
import { advanceQuestions } from "../../src/w5/questions";

registerAllProjections();

const w5Config: W5Config = {
  model: "m",
  throttleMinutes: 10,
  watchTurns: 1,
  askMinStintMinutes: 0,
  askBudgetMinutes: 0,
  askExpireTurns: 2,
  backfillDays: 15,
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
  sessionKindModel: "haiku",
  sessionKindBatch: 0,
  stintMinMinutes: 5,
};

const SESSION = "s1";

/** Real events throughout, so `rebuildAll` has something to replay. */
async function seed(options: { quests: number } = { quests: 1 }) {
  const database = openDatabase(":memory:");
  const store = new EventStore(database);
  const lines: string[] = [];
  const context = {
    database,
    config: {} as never,
    intentConfig: defaultIntentConfig(),
    stdout: (line: string) => lines.push(line),
  };
  await runIntentCommand(["hero", "init", "Saulo"], context);
  const heroId = (database.query("SELECT id FROM heroes").get() as { id: string }).id;

  const questIds: string[] = [];
  for (let index = 1; index <= options.quests; index += 1) {
    const declared = declareQuest(store, database, {
      sessionId: SESSION,
      newQuest: {
        title: `Quest ${index}`,
        outcome: `outcome ${index}`,
        commitment: "promised",
      },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: `2026-09-04T13:0${index}:00.000Z`,
      heroId,
    });
    questIds.push(declared.questId);
  }

  const window: ClassifierWindow = {
    sessionId: SESSION,
    title: "t",
    cwd: "/w/p",
    gitBranch: "main",
    org: "personal",
    project: "p",
    messages: [
      { ts: "2026-09-04T15:00:00.000Z", role: "user", text: "let's start" },
      { ts: "2026-09-04T15:20:00.000Z", role: "user", text: "still on it" },
    ],
    mode: "declared",
    activeQuests: questIds.map((_, index) => ({
      alias: `Q${index + 1}`,
      title: `Quest ${index + 1}`,
      outcome: `outcome ${index + 1}`,
      plan: [],
    })),
    activeQuestAliases: Object.fromEntries(questIds.map((id, index) => [`Q${index + 1}`, id])),
    parentActiveQuests: [],
    parentActiveQuestAliases: {},
    openStintAliases: {},
    planAliases: {},
    openQuests: undefined,
    sessionOpenStints: [],
    recentStints: [],
    recentSideQuests: undefined,
    previousSessionNote: null,
    overlapMessages: [],
    declared: true,
  } as unknown as ClassifierWindow;

  return { database, store, context, lines, questIds, window };
}

function segment(overrides: Partial<ClassifierSegment>): ClassifierSegment {
  return {
    startedAt: "2026-09-04T15:00:00.000Z",
    endedAt: "2026-09-04T15:20:00.000Z",
    what: "compare competitors",
    why: "curiosity",
    belongs: false,
    guess: "a competitor comparison",
    quest: null,
    stint: "new: comparing competitors",
    isSwitch: true,
    trigger: "let's look at the competition",
    confidence: 0.9,
    ...overrides,
  };
}

const options = {
  actor: "hook" as const,
  askingEnabled: true,
  now: "2026-09-04T15:30:00.000Z",
  log: () => {},
  mode: "declared" as const,
  stintMinMinutes: 5,
};

type Fixture = Awaited<ReturnType<typeof seed>>;

function run(fixture: Fixture, segments: ClassifierSegment[], log?: (line: string) => void) {
  return applyResult(
    fixture.store,
    fixture.database,
    fixture.window,
    { segments, sessionNote: null },
    log === undefined ? options : { ...options, log },
  );
}

function doubtedStint(database: Fixture["database"]) {
  return database
    .query(
      `SELECT stints.id as stintId, stints.quest_id as questId, traces.id as traceId, traces.doubt as doubt
         FROM traces JOIN stints ON stints.id = traces.stint_id`,
    )
    .get() as { stintId: string; questId: string | null; traceId: string; doubt: string | null };
}

function questionRows(database: Fixture["database"]) {
  return database.query("SELECT id, kind, state, guess FROM questions").all() as {
    id: string;
    kind: string;
    state: string;
    guess: string | null;
  }[];
}

describe("belongs: false flags the stint and keeps its quest", () => {
  test("the only active quest is kept and the trace is doubted", async () => {
    const fixture = await seed();
    const summary = run(fixture, [segment({})]);

    const row = doubtedStint(fixture.database);
    expect(row.questId).toBe(fixture.questIds[0] as string);
    expect(row.doubt).toBe("a competitor comparison");
    expect(summary.doubts).toBe(1);
    expect(summary.stintsOpened).toBe(1);
  });

  test("with several active quests the one the model named is kept", async () => {
    const fixture = await seed({ quests: 3 });
    run(fixture, [segment({ quest: "Q2" })]);

    expect(doubtedStint(fixture.database).questId).toBe(fixture.questIds[1] as string);
  });

  test("with several active quests and none named the current (newest) one is kept", async () => {
    const fixture = await seed({ quests: 3 });
    run(fixture, [segment({ quest: null })]);

    expect(doubtedStint(fixture.database).questId).toBe(fixture.questIds[2] as string);
  });

  test("a session with no active quest has nothing to keep", async () => {
    const fixture = await seed({ quests: 0 });
    run(fixture, [segment({})]);

    const row = doubtedStint(fixture.database);
    expect(row.questId).toBeNull();
    expect(row.doubt).toBe("a competitor comparison");
  });

  test("a doubt asks one belongs question, still the same kind and guess", async () => {
    const fixture = await seed();
    run(fixture, [segment({})]);

    const [question, ...rest] = questionRows(fixture.database);
    expect(rest).toEqual([]);
    expect(question?.kind).toBe("belongs");
    expect(question?.guess).toBe("a competitor comparison");
  });

  test("the validator keeps a quest alias the window offered and drops one it did not", async () => {
    const fixture = await seed({ quests: 2 });
    const base = {
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:20:00.000Z",
      what: "w",
      why: "y",
      belongs: false,
      guess: "g",
      stint: "new: x",
      isSwitch: false,
      trigger: null,
      confidence: 0.9,
    };
    const kept = validateResult(
      { segments: [{ ...base, quest: "Q1" }], sessionNote: null },
      fixture.window,
    );
    const dropped = validateResult(
      { segments: [{ ...base, quest: "Q7" }], sessionNote: null },
      fixture.window,
    );
    expect(kept.segments[0]?.quest).toBe("Q1");
    expect(dropped.segments[0]?.quest).toBeNull();
  });
});

describe("a doubt without a quoted trigger is recorded but never asked", () => {
  test("no trigger: doubt recorded and logged, no question", async () => {
    const fixture = await seed();
    const lines: string[] = [];
    const summary = run(fixture, [segment({ trigger: null })], (line) => lines.push(line));

    expect(questionRows(fixture.database)).toEqual([]);
    expect(summary.doubts).toBe(1);
    expect(summary.doubtsSilent).toBe(1);
    expect(summary.questionsWatching).toBe(0);
    const row = doubtedStint(fixture.database);
    expect(row.doubt).toBe("a competitor comparison");
    expect(row.questId).toBe(fixture.questIds[0] as string);
    expect(
      lines.some(
        (line) =>
          line.startsWith(`w5 doubt: session s1 stint ${row.stintId} guess "a competitor`) &&
          line.endsWith("(no question: no trigger)"),
      ),
    ).toBe(true);
  });

  test("a blank trigger counts as none", async () => {
    const fixture = await seed();
    run(fixture, [segment({ trigger: "   " })]);
    expect(questionRows(fixture.database)).toEqual([]);
  });

  test("an unrecognized quest alias doubt asks no question even with a trigger", async () => {
    const fixture = await seed({ quests: 2 });
    const validated = validateResult(
      {
        segments: [
          {
            startedAt: "2026-09-04T15:00:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            what: "w",
            why: "y",
            belongs: true,
            guess: null,
            quest: "Q9",
            stint: "new: x",
            isSwitch: false,
            trigger: "a quoted sentence",
            confidence: 0.9,
          },
        ],
        sessionNote: null,
      },
      fixture.window,
    );
    expect(validated.segments[0]?.guess).toBe(UNRECOGNIZED_QUEST_ALIAS_GUESS);

    const summary = applyResult(
      fixture.store,
      fixture.database,
      fixture.window,
      validated,
      options,
    );

    expect(summary.doubts).toBe(1);
    expect(questionRows(fixture.database)).toEqual([]);
    // Flagged, and kept on the newest active quest rather than orphaned.
    const row = doubtedStint(fixture.database);
    expect(row.doubt).toBe(UNRECOGNIZED_QUEST_ALIAS_GUESS);
    expect(row.questId).toBe(fixture.questIds[1] as string);
  });

  test("a quest-not-named doubt with a trigger still asks (2+ active quests, no alias)", async () => {
    const fixture = await seed({ quests: 2 });
    const validated = validateResult(
      {
        segments: [
          {
            startedAt: "2026-09-04T15:00:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            what: "w",
            why: "y",
            belongs: true,
            guess: null,
            quest: null,
            stint: "new: x",
            isSwitch: false,
            trigger: "a quoted sentence",
            confidence: 0.9,
          },
        ],
        sessionNote: null,
      },
      fixture.window,
    );
    expect(validated.segments[0]?.guess).toBe(QUEST_NOT_NAMED_GUESS);

    const summary = applyResult(
      fixture.store,
      fixture.database,
      fixture.window,
      validated,
      options,
    );

    expect(summary.doubtsSilent).toBe(0);
    const [question, ...rest] = questionRows(fixture.database);
    expect(rest).toEqual([]);
    expect(question?.kind).toBe("belongs");
    expect(question?.guess).toBe(QUEST_NOT_NAMED_GUESS);
  });

  test("a quest-not-named doubt without a trigger is silent and says why", async () => {
    const fixture = await seed({ quests: 2 });
    const lines: string[] = [];
    const summary = run(
      fixture,
      [segment({ guess: QUEST_NOT_NAMED_GUESS, trigger: null })],
      (line) => lines.push(line),
    );

    expect(questionRows(fixture.database)).toEqual([]);
    expect(summary.doubtsSilent).toBe(1);
    expect(lines.some((line) => line.endsWith("(no question: no trigger)"))).toBe(true);
  });

  test("the w5 doubt line names the reason and doubtsSilent counts only silent doubts", async () => {
    const fixture = await seed({ quests: 2 });
    const lines: string[] = [];
    const summary = run(
      fixture,
      [
        segment({ trigger: null }),
        segment({
          startedAt: "2026-09-04T15:05:00.000Z",
          endedAt: "2026-09-04T15:08:00.000Z",
          what: "second",
          stint: "new: second thing",
          guess: UNRECOGNIZED_QUEST_ALIAS_GUESS,
        }),
        segment({
          startedAt: "2026-09-04T15:10:00.000Z",
          endedAt: "2026-09-04T15:15:00.000Z",
          what: "third",
          stint: "new: third thing",
        }),
      ],
      (line) => lines.push(line),
    );

    const doubtLines = lines.filter((line) => line.startsWith("w5 doubt:"));
    expect(doubtLines).toHaveLength(3);
    expect(doubtLines[0]).toEndWith('guess "a competitor comparison" (no question: no trigger)');
    expect(doubtLines[1]).toEndWith(
      'guess "unrecognized quest alias" (no question: unrecognized alias)',
    );
    expect(doubtLines[2]).toEndWith('guess "a competitor comparison"');
    expect(summary.doubts).toBe(3);
    expect(summary.doubtsSilent).toBe(2);
    expect(questionRows(fixture.database)).toHaveLength(1);
  });
});

describe("answers", () => {
  async function askedDoubt() {
    const fixture = await seed({ quests: 2 });
    run(fixture, [segment({ quest: "Q1" })]);
    const question = questionRows(fixture.database)[0];
    if (question === undefined) throw new Error("expected a question");
    return { ...fixture, questionId: question.id, row: doubtedStint(fixture.database) };
  }

  function currentDoubt(database: Fixture["database"], traceId: string): string | null {
    return (
      database.query("SELECT doubt FROM traces WHERE id = ?").get(traceId) as {
        doubt: string | null;
      }
    ).doubt;
  }

  test("--belongs clears the doubt and leaves the stint on its quest", async () => {
    const fixture = await askedDoubt();
    expect(currentDoubt(fixture.database, fixture.row.traceId)).not.toBeNull();

    expect(
      await runIntentCommand(["answer", fixture.questionId, "--belongs"], fixture.context),
    ).toBe(0);

    expect(currentDoubt(fixture.database, fixture.row.traceId)).toBeNull();
    expect(doubtedStint(fixture.database).questId).toBe(fixture.questIds[0] as string);
  });

  test("--quest moves the stint to the named quest", async () => {
    const fixture = await askedDoubt();
    const target = fixture.questIds[1] as string;

    expect(
      await runIntentCommand(["answer", fixture.questionId, "--quest", target], fixture.context),
    ).toBe(0);

    expect(doubtedStint(fixture.database).questId).toBe(target);
    expect(currentDoubt(fixture.database, fixture.row.traceId)).toBeNull();
  });

  test("--quest new: moves the stint to a new quest", async () => {
    const fixture = await askedDoubt();

    expect(
      await runIntentCommand(
        ["answer", fixture.questionId, "--quest", "new:Competitor study"],
        fixture.context,
      ),
    ).toBe(0);

    const moved = doubtedStint(fixture.database).questId;
    expect(moved).not.toBeNull();
    expect(fixture.questIds).not.toContain(moved as string);
    expect(
      (
        fixture.database.query("SELECT title FROM quests WHERE id = ?").get(moved) as {
          title: string;
        }
      ).title,
    ).toBe("Competitor study");
  });
});

describe("expiry", () => {
  test("an expired belongs question keeps the quest and the doubt flag", async () => {
    const fixture = await seed();
    run(fixture, [segment({})]);
    const before = doubtedStint(fixture.database);

    // watchTurns 1 promotes it, askExpireTurns 2 then lets it lapse.
    const input = {
      sessionId: SESSION,
      now: "2026-09-04T16:00:00.000Z",
      turnsSinceLastRun: 1,
      sessionStintMinutes: 30,
      resolvedByContext: [],
    };
    advanceQuestions(fixture.store, fixture.database, w5Config, input);
    expect(questionRows(fixture.database)[0]?.state).toBe("asked");
    advanceQuestions(fixture.store, fixture.database, w5Config, input);
    advanceQuestions(fixture.store, fixture.database, w5Config, input);
    expect(questionRows(fixture.database)[0]?.state).toBe("expired");

    const after = doubtedStint(fixture.database);
    expect(after.questId).toBe(fixture.questIds[0] as string);
    expect(after.questId).toBe(before.questId);
    expect(after.doubt).toBe("a competitor comparison");
  });
});

describe("rebuild", () => {
  test("reproduces the doubt flag, and its clearing by --belongs", async () => {
    const fixture = await seed();
    run(fixture, [segment({})]);
    const traceId = doubtedStint(fixture.database).traceId;
    const flag = () =>
      (
        fixture.database.query("SELECT doubt FROM traces WHERE id = ?").get(traceId) as {
          doubt: string | null;
        }
      ).doubt;

    rebuildAll(fixture.database);
    expect(flag()).toBe("a competitor comparison");
    expect(doubtedStint(fixture.database).questId).toBe(fixture.questIds[0] as string);

    const questionId = questionRows(fixture.database)[0]?.id as string;
    await runIntentCommand(["answer", questionId, "--belongs"], fixture.context);
    expect(flag()).toBeNull();

    rebuildAll(fixture.database);
    expect(flag()).toBeNull();
  });

  test("a context-resolved doubt stays flagged after a rebuild", async () => {
    const fixture = await seed();
    run(fixture, [segment({})]);
    const traceId = doubtedStint(fixture.database).traceId;
    const questionId = questionRows(fixture.database)[0]?.id as string;
    advanceQuestions(fixture.store, fixture.database, w5Config, {
      sessionId: SESSION,
      now: "2026-09-04T16:00:00.000Z",
      turnsSinceLastRun: 1,
      sessionStintMinutes: 30,
      resolvedByContext: [questionId],
    });

    rebuildAll(fixture.database);
    expect(
      (
        fixture.database.query("SELECT doubt FROM traces WHERE id = ?").get(traceId) as {
          doubt: string | null;
        }
      ).doubt,
    ).toBe("a competitor comparison");
  });
});

describe("tempad review lists doubted stints", () => {
  function review(fixture: Fixture): string[] {
    const lines: string[] = [];
    const code = runReviewCommand([], {
      database: fixture.database,
      config: {} as never,
      intentConfig: defaultIntentConfig(),
      stdout: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    return lines;
  }

  test("shows the quest title, guess and trigger under their own heading", async () => {
    const fixture = await seed();
    const recent = new Date().toISOString();
    run(fixture, [segment({ startedAt: recent, endedAt: recent })]);

    const lines = review(fixture);
    const heading = lines.indexOf("doubted stints:");
    expect(heading).toBeGreaterThanOrEqual(0);
    const line = lines[heading + 1] as string;
    const stintId = doubtedStint(fixture.database).stintId;
    expect(line).toContain(`stint ${stintId} doubted`);
    expect(line).toContain('quest "Quest 1"');
    expect(line).toContain('guess "a competitor comparison"');
    expect(line).toContain('trigger "let\'s look at the competition"');
  });

  test("omits the trigger when the doubt carried none, and has no section when nothing is doubted", async () => {
    const fixture = await seed();
    expect(review(fixture)).not.toContain("doubted stints:");

    const recent = new Date().toISOString();
    run(fixture, [segment({ startedAt: recent, endedAt: recent, trigger: null })]);

    const line = review(fixture).find((entry) => entry.startsWith("stint ")) as string;
    expect(line).toContain('quest "Quest 1"');
    expect(line).not.toContain("trigger");
  });

  test("drops a stint once its doubt is cleared", async () => {
    const fixture = await seed();
    const recent = new Date().toISOString();
    run(fixture, [segment({ startedAt: recent, endedAt: recent })]);
    const questionId = questionRows(fixture.database)[0]?.id as string;

    await runIntentCommand(["answer", questionId, "--belongs"], fixture.context);

    expect(review(fixture)).not.toContain("doubted stints:");
  });
});
