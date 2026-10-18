import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { declareQuest } from "../../src/intent/declarations";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { applyResult } from "../../src/w5/apply";
import {
  type ClassifierResult,
  type ClassifierSegment,
  type ClassifierWindow,
  DEFAULT_NEW_STINT_REASON,
} from "../../src/w5/classifier";
import { openStintContinuing } from "../../src/w5/lifecycle";

registerAllProjections();

function seed(database: ReturnType<typeof openDatabase>) {
  ensureTables(database);
  const store = new EventStore(database);
  const heroId = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: "hero",
      kind: "hero.created",
      subject: heroId,
      payload: { name: "Saulo" },
    }),
  );
  const questId = "Q1";
  database
    .query(
      "INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at) VALUES (?, 'hero', ?, 'Ship marko-ui', '86 components', 1, 1, 'started', '2026-09-01T00:00:00.000Z')",
    )
    .run(questId, heroId);
  database
    .query(
      "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES ('A1', ?, 'fixing walk order', '2026-09-04T14:00:00.000Z', 1)",
    )
    .run(questId);
  database
    .query(
      `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('T0', 'A1', 'claude-code', 'marko-ui', 'session', '2026-09-04T14:00:00.000Z', '2026-09-04T14:30:00.000Z', 'hero', 'fixing walk order', 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's1', '2026-09-04T14:30:00.000Z')`,
    )
    .run();
  return { store, heroId, questId };
}

const window: ClassifierWindow = {
  sessionId: "s1",
  title: "marko-ui",
  cwd: "/w/marko-ui",
  gitBranch: "main",
  org: "personal",
  project: "marko-ui",
  messages: [],
  mode: "declared",
  activeQuests: [],
  activeQuestAliases: {},
  parentActiveQuests: [],
  parentActiveQuestAliases: {},
  openStintAliases: { S1: "A1" },
  planAliases: {},
  openQuests: [{ id: "Q1", title: "Ship marko-ui", outcome: "86 components", lastStintAt: null }],
  sessionOpenStints: [
    {
      stintId: "A1",
      what: "fixing walk order",
      why: "ship",
      questId: "Q1",
      questTitle: "Ship marko-ui",
      openedAt: "2026-09-04T14:00:00.000Z",
      lastTraceEndedAt: "2026-09-04T14:30:00.000Z",
    },
  ],
  recentStints: [],
  recentSideQuests: [],
  overlapMessages: [],
  previousSessionNote: null,
};

const good: ClassifierResult = {
  segments: [
    {
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:20:00.000Z",
      what: "fix walk order",
      why: "ship marko-ui",
      belongs: true,
      guess: null,
      matchedQuest: "Q1",
      proposedQuest: null,
      matchedStint: "A1",
      continuesStint: null,
      newStintReason: null,
      isSwitch: false,
      trigger: null,
      confidence: 0.9,
      questions: [],
    },
    {
      startedAt: "2026-09-04T15:20:00.000Z",
      endedAt: "2026-09-04T15:20:00.000Z",
      what: "compare Astryx",
      why: "unknown",
      belongs: true,
      guess: null,
      matchedQuest: null,
      proposedQuest: {
        title: "Compare Astryx",
        outcome: "see what they claim",
        commitment: "exploratory",
      },
      matchedStint: null,
      continuesStint: null,
      newStintReason: "a comparison unrelated to the walk order work",
      isSwitch: true,
      trigger: "what does Astryx do for agents?",
      confidence: 0.6,
      questions: ["which_quest"],
    },
  ],
  sessionNote: null,
};

const [baseMatched, baseNew] = good.segments as [
  (typeof good.segments)[number],
  (typeof good.segments)[number],
];

describe("applyResult", () => {
  test("reuses stint, opens new unconfirmed quest, branches, watches question", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const summary = applyResult(store, database, window, good, {
      actor: "hook",
      askingEnabled: true,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
      mode: "inferred",
      stintMinMinutes: 5,
    });

    expect(summary.traces).toBe(2);
    expect(summary.stintsOpened).toBe(1);
    expect(summary.questsProposed).toBe(1);
    expect(summary.branches).toBe(1);
    expect(summary.questionsWatching).toBe(1);

    const traceRows = database.query("SELECT stint_id FROM traces ORDER BY recorded_at").all() as {
      stint_id: string;
    }[];
    expect(traceRows[0]?.stint_id).toBe("A1");
    expect(traceRows).toHaveLength(3);

    const appliedSources = database
      .query("SELECT DISTINCT source FROM traces WHERE id != 'T0'")
      .all() as { source: string }[];
    expect(appliedSources.map((row) => row.source)).toEqual(["session"]);

    const newQuest = database
      .query("SELECT title, confirmed, trigger FROM quests WHERE title = 'Compare Astryx'")
      .get() as { title: string; confirmed: number; trigger: string | null };
    expect(newQuest.confirmed).toBe(0);
    expect(newQuest.trigger).toBe("what does Astryx do for agents?");

    const question = database.query("SELECT state FROM questions").get() as { state: string };
    expect(question.state).toBe("watching");
  });

  test("a switch between segment 2 and 3 branches from segment 2's stint, not window.previousTrace", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const chained: ClassifierResult = {
      segments: [
        {
          startedAt: "2026-09-04T15:00:00.000Z",
          endedAt: "2026-09-04T15:10:00.000Z",
          what: "compare Astryx",
          why: "unknown",
          belongs: true,
          guess: null,
          matchedQuest: null,
          proposedQuest: {
            title: "Compare Astryx",
            outcome: "see what they claim",
            commitment: "exploratory",
          },
          matchedStint: null,
          continuesStint: null,
          newStintReason: "a comparison unrelated to the walk order work",
          isSwitch: true,
          trigger: "what does Astryx do for agents?",
          confidence: 0.6,
          questions: [],
        },
        {
          startedAt: "2026-09-04T15:10:00.000Z",
          endedAt: "2026-09-04T15:20:00.000Z",
          what: "read Astryx docs",
          why: "unknown",
          belongs: true,
          guess: null,
          matchedQuest: null,
          proposedQuest: null,
          matchedStint: null,
          continuesStint: null,
          newStintReason: "still reading docs on the new topic",
          isSwitch: false,
          trigger: null,
          confidence: 0.7,
          questions: [],
        },
        {
          startedAt: "2026-09-04T15:20:00.000Z",
          endedAt: "2026-09-04T15:30:00.000Z",
          what: "check email",
          why: "unknown",
          belongs: true,
          guess: null,
          matchedQuest: null,
          proposedQuest: {
            title: "Check email",
            outcome: "clear inbox",
            commitment: "personal",
          },
          matchedStint: null,
          continuesStint: null,
          newStintReason: "an unrelated personal errand",
          isSwitch: true,
          trigger: "let me check email real quick",
          confidence: 0.5,
          questions: [],
        },
      ],
      sessionNote: null,
    };

    const summary = applyResult(store, database, window, chained, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:31:00.000Z",
      log: () => {},
      mode: "inferred",
      stintMinMinutes: 5,
    });

    // Two switches happened (Q1 -> Compare Astryx, Compare Astryx -> Check email).
    // With the bug (comparing against the static window.previousTrace = A1/Q1),
    // only one branch would be recorded because segment 3's questId (Check email)
    // differs from A1's quest (Q1) too, but the branch's deviates_from would
    // wrongly point at A1 instead of the stint segment 2 landed on.
    expect(summary.branches).toBe(2);

    // Segment 2 did not switch, so it stays on the stint segment 1 opened.
    const astryxStint = database
      .query("SELECT id FROM stints WHERE outcome = 'compare Astryx'")
      .get() as { id: string };
    const docsTrace = database
      .query("SELECT stint_id FROM traces WHERE what = 'read Astryx docs'")
      .get() as { stint_id: string };
    expect(docsTrace.stint_id).toBe(astryxStint.id);
    const emailQuest = database
      .query("SELECT id, deviates_from_stint_id FROM quests WHERE title = 'Check email'")
      .get() as { id: string; deviates_from_stint_id: string };

    expect(emailQuest.deviates_from_stint_id).toBe(astryxStint.id);
  });

  test("askingEnabled false records no question row", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    applyResult(store, database, window, good, {
      actor: "backfill",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
      mode: "inferred",
      stintMinMinutes: 5,
    });

    const count = database.query("SELECT COUNT(*) as count FROM questions").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  test("matchedStint with a conflicting quest keeps the stint's quest and counts a conflict", () => {
    const database = openDatabase(":memory:");
    const { store, heroId } = seed(database);
    database
      .query(
        "INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at) VALUES ('Q9', 'hero', ?, 'Other quest', 'other', 1, 1, 'started', '2026-09-01T00:00:00.000Z')",
      )
      .run(heroId);

    const conflicting: ClassifierResult = {
      segments: [
        {
          ...baseMatched,
          belongs: true,
          guess: null,
          matchedQuest: "Q9",
          matchedStint: "A1",
          continuesStint: null,
          newStintReason: null,
        },
      ],
      sessionNote: null,
    };

    const logs: string[] = [];
    const summary = applyResult(store, database, window, conflicting, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: (line) => logs.push(line),
      mode: "inferred",
      stintMinMinutes: 5,
    });

    expect(summary.doubts).toBe(1);
    expect(summary.stintsOpened).toBe(0);
    expect(logs).toHaveLength(1);

    const stint = database.query("SELECT quest_id FROM stints WHERE id = 'A1'").get() as {
      quest_id: string;
    };
    expect(stint.quest_id).toBe("Q1");

    const trace = database.query("SELECT stint_id FROM traces WHERE id != 'T0'").get() as {
      stint_id: string;
    };
    expect(trace.stint_id).toBe("A1");
  });

  test("matchedQuest null on a matched stint is no opinion: quest kept, no conflict", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const noOpinion: ClassifierResult = {
      segments: [
        {
          ...baseMatched,
          // The classifier did not judge the quest. That is silence, not a claim
          // that the stint has none, so A1 keeps Q1 and nothing is reported.
          belongs: true,
          guess: null,
          matchedQuest: null,
          proposedQuest: null,
          matchedStint: "A1",
          continuesStint: null,
          newStintReason: null,
        },
      ],
      sessionNote: null,
    };

    const logs: string[] = [];
    const summary = applyResult(store, database, window, noOpinion, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: (line) => logs.push(line),
      mode: "inferred",
      stintMinMinutes: 5,
    });

    expect(summary.doubts).toBe(0);
    expect(summary.questProposedOnMatched).toBe(0);
    expect(summary.stintsOpened).toBe(0);
    expect(logs).toHaveLength(0);

    const stint = database.query("SELECT quest_id FROM stints WHERE id = 'A1'").get() as {
      quest_id: string;
    };
    expect(stint.quest_id).toBe("Q1");
  });

  test("proposedQuest on a matched stint with no quest creates and attaches it", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);
    // A1 starts with no quest, so the proposal fills a gap rather than contesting.
    database.query("UPDATE stints SET quest_id = NULL WHERE id = 'A1'").run();

    const proposing: ClassifierResult = {
      segments: [
        {
          ...baseMatched,
          belongs: true,
          guess: null,
          matchedQuest: null,
          proposedQuest: {
            title: "Ship the walk order fix",
            outcome: "land it",
            commitment: "personal",
          },
          matchedStint: "A1",
          continuesStint: null,
          newStintReason: null,
        },
      ],
      sessionNote: null,
    };

    const logs: string[] = [];
    const summary = applyResult(store, database, window, proposing, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: (line) => logs.push(line),
      mode: "inferred",
      stintMinMinutes: 5,
    });

    expect(summary.questProposedOnMatched).toBe(1);
    expect(summary.questsProposed).toBe(1);
    expect(summary.doubts).toBe(0);
    expect(summary.stintsOpened).toBe(0);
    expect(logs).toHaveLength(1);

    const stint = database.query("SELECT quest_id FROM stints WHERE id = 'A1'").get() as {
      quest_id: string | null;
    };
    expect(stint.quest_id).not.toBeNull();

    const quest = database
      .query("SELECT title, confirmed FROM quests WHERE id = ?")
      .get(stint.quest_id) as { title: string; confirmed: number };
    expect(quest.title).toBe("Ship the walk order fix");
    expect(quest.confirmed).toBe(0);
  });

  test("proposedQuest on a matched stint that already has a quest changes nothing", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const proposing: ClassifierResult = {
      segments: [
        {
          ...baseMatched,
          belongs: true,
          guess: null,
          matchedQuest: null,
          proposedQuest: {
            title: "Something else entirely",
            outcome: "no",
            commitment: "personal",
          },
          matchedStint: "A1",
          continuesStint: null,
          newStintReason: null,
        },
      ],
      sessionNote: null,
    };

    const summary = applyResult(store, database, window, proposing, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
      mode: "inferred",
      stintMinMinutes: 5,
    });

    expect(summary.questProposedOnMatched).toBe(0);
    expect(summary.questsProposed).toBe(0);

    const stint = database.query("SELECT quest_id FROM stints WHERE id = 'A1'").get() as {
      quest_id: string;
    };
    expect(stint.quest_id).toBe("Q1");
  });

  describe("matchedQuest on a matched stint that has no quest", () => {
    const quest = (matchedQuest: string | null): ClassifierResult => ({
      segments: [
        {
          ...baseMatched,
          belongs: true,
          guess: null,
          matchedQuest,
          proposedQuest: null,
          matchedStint: "A1",
          continuesStint: null,
          newStintReason: null,
        },
      ],
      sessionNote: null,
    });
    const run = (
      database: ReturnType<typeof openDatabase>,
      store: EventStore,
      result: ClassifierResult,
      logs: string[] = [],
    ) =>
      applyResult(store, database, window, result, {
        actor: "hook",
        askingEnabled: false,
        now: "2026-09-04T15:21:00.000Z",
        log: (line) => logs.push(line),
        mode: "inferred",
        stintMinMinutes: 5,
      });
    const stintQuest = (database: ReturnType<typeof openDatabase>): string | null =>
      (
        database.query("SELECT quest_id FROM stints WHERE id = 'A1'").get() as {
          quest_id: string | null;
        }
      ).quest_id;

    test("an open quest the window offered is attached through stint.assigned, no doubt", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      database.query("UPDATE stints SET quest_id = NULL WHERE id = 'A1'").run();

      const logs: string[] = [];
      const summary = run(database, store, quest("Q1"), logs);

      expect(stintQuest(database)).toBe("Q1");
      expect(summary.doubts).toBe(0);
      expect(summary.questAttachedOnMatched).toBe(1);
      expect(summary.questProposedOnMatched).toBe(0);
      expect(summary.stintsOpened).toBe(0);
      expect(logs.filter((line) => line.includes("quest conflict"))).toHaveLength(0);
      expect(logs.filter((line) => line.includes("attached Q1"))).toHaveLength(1);

      const assigned = database
        .query("SELECT subject, payload FROM events WHERE kind = 'stint.assigned'")
        .all() as { subject: string; payload: string }[];
      expect(assigned.map((row) => row.subject)).toEqual(["A1"]);
      expect(JSON.parse(assigned[0]?.payload ?? "{}").quest).toBe("Q1");
    });

    test("the trace of the segment lands on the attached quest, so it is attributed", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      database.query("UPDATE stints SET quest_id = NULL WHERE id = 'A1'").run();

      run(database, store, quest("Q1"));

      const unattributed = database
        .query(
          "SELECT COUNT(*) AS n FROM traces JOIN stints ON stints.id = traces.stint_id WHERE stints.quest_id IS NULL",
        )
        .get() as { n: number };
      expect(unattributed.n).toBe(0);
    });

    test("a quest the window never offered is not attached: still a doubt", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      database.query("UPDATE stints SET quest_id = NULL WHERE id = 'A1'").run();

      const summary = run(database, store, quest("01GARBLEDGARBLEDGARBLEDGA"));

      expect(stintQuest(database)).toBeNull();
      expect(summary.doubts).toBe(1);
      expect(summary.questAttachedOnMatched).toBe(0);
    });

    test("a quest that is no longer open is not attached", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      database.query("UPDATE stints SET quest_id = NULL WHERE id = 'A1'").run();

      const summary = applyResult(store, database, { ...window, openQuests: [] }, quest("Q1"), {
        actor: "hook",
        askingEnabled: false,
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
        mode: "inferred",
        stintMinMinutes: 5,
      });

      expect(stintQuest(database)).toBeNull();
      expect(summary.doubts).toBe(1);
      expect(summary.questAttachedOnMatched).toBe(0);
    });

    describe("a stint that is not this session's open stint", () => {
      const seedOther = (database: ReturnType<typeof openDatabase>) => {
        database
          .query(
            "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES ('OTHER', NULL, 'someone else', '2026-09-04T13:00:00.000Z', 1)",
          )
          .run();
        database
          .query(
            `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
             VALUES ('T-other', 'OTHER', 'claude-code', 'elsewhere', 'session', '2026-09-04T13:00:00.000Z', '2026-09-04T13:30:00.000Z', 'hero', 'someone else', 'w', 'x', 'claude-code', 0.9, 'assistant', 's-other', '2026-09-04T13:30:00.000Z')`,
          )
          .run();
      };
      const matchOther = (): ClassifierResult => ({
        segments: [
          {
            ...baseMatched,
            belongs: true,
            guess: null,
            matchedQuest: "Q1",
            proposedQuest: null,
            matchedStint: "OTHER",
            continuesStint: null,
            newStintReason: null,
          },
        ],
        sessionNote: null,
      });
      const otherQuest = (database: ReturnType<typeof openDatabase>): string | null =>
        (
          database.query("SELECT quest_id FROM stints WHERE id = 'OTHER'").get() as {
            quest_id: string | null;
          }
        ).quest_id;
      const apply = (
        database: ReturnType<typeof openDatabase>,
        store: EventStore,
        windowToApply: ClassifierWindow,
      ) =>
        applyResult(store, database, windowToApply, matchOther(), {
          actor: "hook",
          askingEnabled: false,
          now: "2026-09-04T15:21:00.000Z",
          log: () => {},
          mode: "inferred",
          stintMinMinutes: 5,
        });

      test("another session's stint the window never offered keeps no quest: still a doubt", () => {
        const database = openDatabase(":memory:");
        const { store } = seed(database);
        seedOther(database);

        const summary = apply(database, store, window);

        expect(otherQuest(database)).toBeNull();
        expect(summary.doubts).toBe(1);
        expect(summary.questAttachedOnMatched).toBe(0);
        expect(
          database.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'stint.assigned'").get(),
        ).toEqual({ n: 0 });
      });

      test("another session's stint the window offered as recent is not attached either", () => {
        const database = openDatabase(":memory:");
        const { store } = seed(database);
        seedOther(database);

        const summary = apply(database, store, {
          ...window,
          recentStints: [
            {
              stintId: "OTHER",
              what: "someone else",
              why: "w",
              questId: null,
              questTitle: null,
              openedAt: "2026-09-04T13:00:00.000Z",
              lastTraceEndedAt: "2026-09-04T13:30:00.000Z",
              closedAt: null,
              closeReason: null,
            },
          ],
        });

        expect(otherQuest(database)).toBeNull();
        expect(summary.doubts).toBe(1);
        expect(summary.questAttachedOnMatched).toBe(0);
      });
    });

    test("a stint that already has another quest keeps it: still a doubt", () => {
      const database = openDatabase(":memory:");
      const { store, heroId } = seed(database);
      database
        .query(
          "INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at) VALUES ('Q2', 'hero', ?, 'Other', 'o', 1, 1, 'started', '2026-09-01T00:00:00.000Z')",
        )
        .run(heroId);

      const summary = applyResult(
        store,
        database,
        {
          ...window,
          openQuests: [
            ...(window.openQuests ?? []),
            { id: "Q2", title: "Other", outcome: "o", lastStintAt: null },
          ],
        },
        quest("Q2"),
        {
          actor: "hook",
          askingEnabled: false,
          now: "2026-09-04T15:21:00.000Z",
          log: () => {},
          mode: "inferred",
          stintMinMinutes: 5,
        },
      );

      expect(stintQuest(database)).toBe("Q1");
      expect(summary.doubts).toBe(1);
      expect(summary.questAttachedOnMatched).toBe(0);
    });

    test("matchedQuest null on a quest-less stint attaches nothing", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      database.query("UPDATE stints SET quest_id = NULL WHERE id = 'A1'").run();

      const summary = run(database, store, quest(null));

      expect(stintQuest(database)).toBeNull();
      expect(summary.doubts).toBe(0);
      expect(summary.questAttachedOnMatched).toBe(0);
    });
  });

  test("continuesStint opens a new stint linked to the closed one, keeping its quest", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);
    database
      .query(
        `INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, close_reason, revision)
         VALUES ('A0', 'Q1', 'fixing walk order', '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 'session_end', 1)`,
      )
      .run();

    const continuing: ClassifierResult = {
      segments: [
        {
          ...baseMatched,
          belongs: true,
          guess: null,
          matchedQuest: "Q1",
          matchedStint: null,
          continuesStint: "A0",
          newStintReason: null,
        },
      ],
      sessionNote: null,
    };

    const summary = applyResult(store, database, window, continuing, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
      mode: "inferred",
      stintMinMinutes: 5,
    });

    expect(summary.stintsOpened).toBe(1);
    expect(summary.doubts).toBe(0);

    const opened = database
      .query("SELECT id, quest_id, continues FROM stints WHERE continues IS NOT NULL")
      .get() as { id: string; quest_id: string | null; continues: string };
    expect(opened.continues).toBe("A0");
    expect(opened.quest_id).toBe("Q1");
  });

  test("a switch to a different stint closes nothing", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const switching: ClassifierResult = {
      segments: [
        {
          ...baseMatched,
          startedAt: "2026-09-04T15:00:00.000Z",
          endedAt: "2026-09-04T15:10:00.000Z",
          belongs: true,
          guess: null,
          matchedQuest: "Q1",
          matchedStint: "A1",
          continuesStint: null,
          newStintReason: null,
          isSwitch: false,
        },
        {
          ...baseNew,
          startedAt: "2026-09-04T15:10:00.000Z",
          endedAt: "2026-09-04T15:20:00.000Z",
          matchedStint: null,
          continuesStint: null,
          newStintReason: "a different outcome entirely",
          isSwitch: true,
          questions: [],
        },
      ],
      sessionNote: null,
    };

    applyResult(store, database, window, switching, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
      mode: "inferred",
      stintMinMinutes: 5,
    });

    const untouched = database
      .query("SELECT closed_at, close_reason FROM stints WHERE id = 'A1'")
      .get() as { closed_at: string | null; close_reason: string | null };
    expect(untouched.closed_at).toBeNull();
    expect(untouched.close_reason).toBeNull();

    const closedCount = database
      .query("SELECT COUNT(*) as count FROM stints WHERE closed_at IS NOT NULL")
      .get() as { count: number };
    expect(closedCount.count).toBe(0);
  });

  test("a switch landing on a matched still-open stint closes neither stint", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);
    database
      .query(
        `INSERT INTO stints (id, quest_id, outcome, opened_at, revision)
         VALUES ('B1', 'Q1', 'second open stint', '2026-09-04T14:10:00.000Z', 1)`,
      )
      .run();

    const twoOpenWindow: ClassifierWindow = {
      ...window,
      sessionOpenStints: [
        ...window.sessionOpenStints,
        {
          stintId: "B1",
          what: "second open stint",
          why: "ship",
          questId: "Q1",
          questTitle: "Ship marko-ui",
          openedAt: "2026-09-04T14:10:00.000Z",
          lastTraceEndedAt: "2026-09-04T14:10:00.000Z",
        },
      ],
    };

    const switchToA1: ClassifierResult = {
      segments: [
        {
          ...baseMatched,
          startedAt: "2026-09-04T15:10:00.000Z",
          endedAt: "2026-09-04T15:20:00.000Z",
          belongs: true,
          guess: null,
          matchedQuest: "Q1",
          matchedStint: "A1",
          continuesStint: null,
          newStintReason: null,
          isSwitch: true,
          questions: [],
        },
      ],
      sessionNote: null,
    };

    applyResult(store, database, twoOpenWindow, switchToA1, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
      mode: "inferred",
      stintMinMinutes: 5,
    });

    const a1 = database
      .query("SELECT closed_at, close_reason FROM stints WHERE id = 'A1'")
      .get() as { closed_at: string | null; close_reason: string | null };
    expect(a1.closed_at).toBeNull();

    const b1 = database
      .query("SELECT closed_at, close_reason FROM stints WHERE id = 'B1'")
      .get() as { closed_at: string | null; close_reason: string | null };
    expect(b1.closed_at).toBeNull();
  });

  test("A, B(switch), A(switch): both A and B stay open, A gets two traces, one branch, no closes", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const segments: ClassifierResult = {
      segments: [
        {
          ...baseNew,
          startedAt: "2026-09-04T15:00:00.000Z",
          endedAt: "2026-09-04T15:10:00.000Z",
          what: "switch to B",
          belongs: true,
          guess: null,
          matchedQuest: null,
          proposedQuest: { title: "Quest B", outcome: "do B", commitment: "exploratory" },
          matchedStint: null,
          continuesStint: null,
          newStintReason: "switch to B",
          isSwitch: true,
          trigger: "waiting on the build",
          questions: [],
        },
        {
          ...baseMatched,
          startedAt: "2026-09-04T15:10:00.000Z",
          endedAt: "2026-09-04T15:20:00.000Z",
          what: "back to walk order",
          belongs: true,
          guess: null,
          matchedQuest: "Q1",
          matchedStint: "A1",
          continuesStint: null,
          newStintReason: null,
          isSwitch: true,
          trigger: "build finished",
          questions: [],
        },
      ],
      sessionNote: null,
    };

    const summary = applyResult(store, database, window, segments, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
      mode: "inferred",
      stintMinMinutes: 5,
    });

    // One branch (A to B); the return to A is attention moving back to a quest
    // already open in the session, not a nexus event.
    expect(summary.branches).toBe(1);

    const closedCount = database
      .query("SELECT COUNT(*) as count FROM stints WHERE closed_at IS NOT NULL")
      .get() as { count: number };
    expect(closedCount.count).toBe(0);

    const bOpen = database
      .query("SELECT closed_at FROM stints WHERE outcome = 'switch to B'")
      .get() as { closed_at: string | null };
    expect(bOpen.closed_at).toBeNull();

    const a1Traces = database
      .query("SELECT COUNT(*) as count FROM traces WHERE stint_id = 'A1'")
      .get() as { count: number };
    expect(a1Traces.count).toBe(2); // T0 from seed() plus the returning segment.
  });

  test("matchedStint naming an id absent from the slice opens a new stint and counts it", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const hallucinated: ClassifierResult = {
      segments: [{ ...baseMatched, matchedStint: "A-does-not-exist", matchedQuest: "Q1" }],
      sessionNote: null,
    };

    const logs: string[] = [];
    const summary = applyResult(store, database, window, hallucinated, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: (line) => logs.push(line),
      mode: "inferred",
      stintMinMinutes: 5,
    });

    expect(summary.unknownStintIds).toBe(1);
    expect(summary.stintsOpened).toBe(1);
    expect(summary.doubts).toBe(0);
    expect(logs).toHaveLength(1);

    const trace = database.query("SELECT stint_id FROM traces WHERE id != 'T0'").get() as {
      stint_id: string;
    };
    expect(trace.stint_id).not.toBe("A-does-not-exist");
  });

  // A later window already closed the stint (a `--force` / `--reclassify` re-run), but
  // the segment ran at 15:00-15:20, before the close when `closedAt` is 15:30 and across
  // it when `closedAt` is 15:10.
  for (const selector of ["matchedStint", "continuesStint"] as const) {
    const apply = (closedAt: string) => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      database
        .query(
          `INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, close_reason, revision)
           VALUES ('A-later-closed', 'Q1', 'still going at 15:00', '2026-09-04T14:30:00.000Z', ?, 'idle', 1)`,
        )
        .run(closedAt);
      const summary = applyResult(
        store,
        database,
        window,
        {
          segments: [
            {
              ...baseMatched,
              matchedStint: null,
              continuesStint: null,
              [selector]: "A-later-closed",
              matchedQuest: "Q1",
            },
          ],
          sessionNote: null,
        },
        {
          actor: "hook",
          askingEnabled: false,
          now: "2026-09-04T15:21:00.000Z",
          log: () => {},
          stintMinMinutes: 5,
          mode: "inferred" as const,
        },
      );
      return { database, summary };
    };

    test(`${selector} naming a stint that was still open when the segment ended reuses it: no overlapping continues stint`, () => {
      const { database, summary } = apply("2026-09-04T15:30:00.000Z");

      expect(summary.stintsOpened).toBe(0);
      expect(summary.unknownStintIds).toBe(0);
      expect(
        database.query("SELECT COUNT(*) AS n FROM stints WHERE continues IS NOT NULL").get(),
      ).toEqual({ n: 0 });
      expect(
        database.query("SELECT COUNT(*) AS n FROM traces WHERE stint_id = 'A-later-closed'").get(),
      ).toEqual({ n: 1 });
    });

    test(`${selector} naming a stint that closed inside the segment continues it: no trace past its closed_at`, () => {
      const { database, summary } = apply("2026-09-04T15:10:00.000Z");

      expect(summary.stintsOpened).toBe(1);
      expect(summary.unknownStintIds).toBe(0);
      expect(
        database.query("SELECT COUNT(*) AS n FROM traces WHERE stint_id = 'A-later-closed'").get(),
      ).toEqual({ n: 0 });
      expect(
        database.query("SELECT quest_id AS q FROM stints WHERE continues = 'A-later-closed'").all(),
      ).toEqual([{ q: "Q1" }]);
    });
  }

  test("matchedStint naming a stint that is retracted is not reused, one that is closed is continued", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);
    database
      .query(
        `INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, close_reason, revision)
         VALUES ('A-closed', 'Q1', 'already finished', '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 'idle', 1)`,
      )
      .run();
    database
      .query(
        `INSERT INTO stints (id, quest_id, outcome, opened_at, retracted_at, revision)
         VALUES ('A-retracted', 'Q1', 'wrong call', '2026-09-04T12:00:00.000Z', '2026-09-04T12:30:00.000Z', 1)`,
      )
      .run();

    const closedWindow: ClassifierWindow = {
      ...window,
      sessionOpenStints: [
        ...window.sessionOpenStints,
        {
          stintId: "A-retracted",
          what: "wrong call",
          why: "unknown",
          questId: "Q1",
          questTitle: "Ship marko-ui",
          openedAt: "2026-09-04T12:00:00.000Z",
          lastTraceEndedAt: "2026-09-04T12:30:00.000Z",
        },
      ],
    };

    const summary = applyResult(
      store,
      database,
      closedWindow,
      {
        segments: [
          { ...baseMatched, matchedStint: "A-closed", matchedQuest: "Q1" },
          {
            ...baseNew,
            matchedStint: "A-retracted",
            continuesStint: null,
            newStintReason: null,
            belongs: true,
            guess: null,
            matchedQuest: "Q1",
            proposedQuest: null,
            isSwitch: false,
            questions: [],
          },
        ],
        sessionNote: null,
      },
      {
        actor: "hook",
        askingEnabled: false,
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
        stintMinMinutes: 5,
        mode: "inferred" as const,
      },
    );

    // The retracted stint is unknown; the closed one is a return, not unknown.
    expect(summary.unknownStintIds).toBe(1);
    const reused = database
      .query("SELECT COUNT(*) as count FROM traces WHERE stint_id IN ('A-closed', 'A-retracted')")
      .get() as { count: number };
    expect(reused.count).toBe(0);
    const continued = database
      .query("SELECT quest_id as questId FROM stints WHERE continues = 'A-closed'")
      .all() as { questId: string | null }[];
    expect(continued).toEqual([{ questId: "Q1" }]);
  });

  describe("an id offered for the other kind of thing", () => {
    const inferred = {
      actor: "hook" as const,
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      stintMinMinutes: 5,
      mode: "inferred" as const,
    };

    const stintSlice = (id: string, questId: string | null, closedAt: string | null = null) => ({
      stintId: id,
      what: "work",
      why: "ship",
      questId,
      questTitle: null,
      openedAt: "2026-09-04T13:00:00.000Z",
      lastTraceEndedAt: "2026-09-04T13:30:00.000Z",
      closedAt,
      closeReason: closedAt === null ? null : "idle",
    });
    const closedA1 = stintSlice("A1", "Q1", "2026-09-04T14:40:00.000Z");
    /** The seed's A1 is closed: it is no longer open, only a recent candidate. */
    const closedWindow: ClassifierWindow = {
      ...window,
      sessionOpenStints: [],
      recentStints: [closedA1],
    };

    function run(
      database: ReturnType<typeof openDatabase>,
      store: EventStore,
      segment: Partial<ClassifierSegment>,
      candidates: ClassifierWindow = window,
      options: Partial<Parameters<typeof applyResult>[4]> = {},
    ) {
      const logs: string[] = [];
      const summary = applyResult(
        store,
        database,
        candidates,
        { segments: [{ ...baseMatched, ...segment }], sessionNote: null },
        { ...inferred, log: (line) => logs.push(line), ...options },
      );
      return { summary, logs };
    }

    const closeA1 = (database: ReturnType<typeof openDatabase>) =>
      database
        .query("UPDATE stints SET closed_at = '2026-09-04T14:40:00.000Z', close_reason = 'idle'")
        .run();

    const newStints = (database: ReturnType<typeof openDatabase>) =>
      database
        .query(
          "SELECT id, continues, quest_id as questId FROM stints WHERE id NOT IN ('A1', 'B1', 'A-future', 'A-other')",
        )
        .all() as { id: string; continues: string | null; questId: string | null }[];

    const tracesOn = (database: ReturnType<typeof openDatabase>, stint: string) =>
      (
        database.query("SELECT COUNT(*) as count FROM traces WHERE stint_id = ?").get(stint) as {
          count: number;
        }
      ).count;

    test("a quest id in matchedStint reuses the open stint of that quest, counts a repair, caps confidence", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);

      const { summary, logs } = run(database, store, { matchedStint: "Q1", matchedQuest: null });

      expect(summary.unknownStintIds).toBe(0);
      expect(summary.selectorRepaired).toBe(1);
      expect(summary.stintsOpened).toBe(0);
      expect(summary.doubts).toBe(0);
      expect(logs.some((line) => line.includes("stint selector named quest Q1"))).toBe(true);
      expect(tracesOn(database, "A1")).toBe(2);
      const confidence = database.query("SELECT confidence FROM traces WHERE id != 'T0'").get() as {
        confidence: number;
      };
      expect(confidence.confidence).toBe(0.5);
    });

    test("an unrepaired segment is counted as none and keeps its confidence", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);

      const { summary } = run(database, store, {});

      expect(summary.selectorRepaired).toBe(0);
      const confidence = database.query("SELECT confidence FROM traces WHERE id != 'T0'").get() as {
        confidence: number;
      };
      expect(confidence.confidence).toBe(0.9);
    });

    test("a quest id in continuesStint continues the closed stint of that quest", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      closeA1(database);

      const { summary } = run(
        database,
        store,
        { matchedStint: null, continuesStint: "Q1", matchedQuest: null, newStintReason: null },
        closedWindow,
      );

      expect(summary.unknownStintIds).toBe(0);
      expect(summary.stintsOpened).toBe(1);
      expect(newStints(database)).toEqual([
        { id: expect.any(String), continues: "A1", questId: "Q1" },
      ]);
    });

    test("a quest id with no stint of it among the candidates opens a new stint under that quest", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);

      const { summary } = run(
        database,
        store,
        { matchedStint: "Q1", matchedQuest: null },
        { ...window, sessionOpenStints: [], recentStints: [] },
      );

      expect(summary.unknownStintIds).toBe(0);
      expect(newStints(database)).toEqual([
        { id: expect.any(String), continues: null, questId: "Q1" },
      ]);
    });

    test("a stint opened after the segment is never the target of a repair", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      // Opened 09-06 with a trace of this session, but absent from the window
      // because buildWindow bounds candidates by windowEnd.
      database
        .query(
          "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES ('A-future', 'Q1', 'later work', '2026-09-06T10:00:00.000Z', 1)",
        )
        .run();
      database
        .query(
          `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
           VALUES ('T-future', 'A-future', 'claude-code', 'marko-ui', 'session', '2026-09-06T10:00:00.000Z', '2026-09-06T10:30:00.000Z', 'hero', 'later', 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's1', '2026-09-06T10:30:00.000Z')`,
        )
        .run();

      run(database, store, { matchedStint: "Q1", matchedQuest: null });
      expect(tracesOn(database, "A1")).toBe(2);
      expect(tracesOn(database, "A-future")).toBe(1);

      // The same holds for a closed A1: the new stint continues it, not A-future.
      const second = openDatabase(":memory:");
      const { store: secondStore } = seed(second);
      closeA1(second);
      second
        .query(
          "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES ('A-future', 'Q1', 'later work', '2026-09-06T10:00:00.000Z', 1)",
        )
        .run();
      run(
        second,
        secondStore,
        { matchedStint: null, continuesStint: "Q1", matchedQuest: null, newStintReason: null },
        closedWindow,
      );
      expect(newStints(second).map((stint) => stint.continues)).toEqual(["A1"]);
    });

    test("a quest that is not an open candidate is not revived", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      database
        .query(
          `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
           VALUES ('Q-abandoned', 'hero', 'H', 'Dropped', 'x', 1, 1, 'abandoned', '2026-09-01T00:00:00.000Z')`,
        )
        .run();
      database.query("UPDATE stints SET quest_id = 'Q-abandoned' WHERE id = 'A1'").run();

      const { summary } = run(database, store, { matchedStint: "Q-abandoned", matchedQuest: null });

      expect(summary.unknownStintIds).toBe(1);
      expect(summary.selectorRepaired).toBe(0);
    });

    test("another session's open stint is not reused through its quest", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      database
        .query(
          "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES ('A-other', 'Q1', 'elsewhere', '2026-09-04T13:00:00.000Z', 1)",
        )
        .run();

      run(
        database,
        store,
        { matchedStint: "Q1", matchedQuest: null },
        { ...window, sessionOpenStints: [], recentStints: [stintSlice("A-other", "Q1")] },
      );

      expect(tracesOn(database, "A-other")).toBe(0);
      expect(newStints(database)).toEqual([
        { id: expect.any(String), continues: null, questId: "Q1" },
      ]);
    });

    test("a stint id in matchedQuest next to the right matchedStint is no conflict", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);

      const { summary } = run(database, store, { matchedStint: "A1", matchedQuest: "A1" });

      expect(summary.doubts).toBe(0);
      expect(summary.unknownStintIds).toBe(0);
      expect(summary.stintsOpened).toBe(0);
      expect(summary.selectorRepaired).toBe(1);
    });

    test("two valid selectors that disagree still count a conflict", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);

      // matchedStint A1 belongs to Q1, matchedQuest names B1, a stint of Q2.
      database
        .query(
          `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
           VALUES ('Q2', 'hero', 'H', 'Other', 'y', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
        )
        .run();
      database
        .query(
          "INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, close_reason, revision) VALUES ('B1', 'Q2', 'other work', '2026-09-04T13:00:00.000Z', '2026-09-04T14:00:00.000Z', 'idle', 1)",
        )
        .run();
      const { summary, logs } = run(
        database,
        store,
        { matchedStint: "A1", matchedQuest: "B1" },
        {
          ...window,
          openQuests: [
            ...(window.openQuests ?? []),
            { id: "Q2", title: "Other", outcome: "y", lastStintAt: null },
          ],
          recentStints: [stintSlice("B1", "Q2", "2026-09-04T14:00:00.000Z")],
        },
      );

      expect(summary.doubts).toBe(1);
      expect(logs.some((line) => line.includes("w5 quest conflict"))).toBe(true);
      expect(tracesOn(database, "A1")).toBe(2);
    });

    test("a stint id in matchedQuest with no selector and the defaulted reason is the selector", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);

      const { summary } = run(database, store, {
        matchedStint: null,
        matchedQuest: "A1",
        newStintReason: DEFAULT_NEW_STINT_REASON,
      });

      expect(summary.doubts).toBe(0);
      expect(summary.stintsOpened).toBe(0);
      expect(tracesOn(database, "A1")).toBe(2);
    });

    test("a stint id in matchedQuest does not override an explicit newStintReason", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);

      const { summary } = run(database, store, {
        matchedStint: null,
        matchedQuest: "A1",
        newStintReason: "a comparison unrelated to the walk order work",
      });

      expect(summary.stintsOpened).toBe(1);
      expect(summary.doubts).toBe(0);
      expect(tracesOn(database, "A1")).toBe(1);
      // matchedQuest stands for A1's quest, so the new stint belongs to it.
      expect(newStints(database)).toEqual([
        { id: expect.any(String), continues: null, questId: "Q1" },
      ]);
    });

    test("a quest id in the stint slot never links across quests when matchedQuest names another", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      closeA1(database);
      database
        .query(
          `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
           VALUES ('Q2', 'hero', 'H', 'Other', 'y', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
        )
        .run();

      const { summary } = run(
        database,
        store,
        { matchedStint: null, continuesStint: "Q1", matchedQuest: "Q2", newStintReason: null },
        {
          ...closedWindow,
          openQuests: [
            ...(window.openQuests ?? []),
            { id: "Q2", title: "Other", outcome: "y", lastStintAt: null },
          ],
        },
      );

      expect(summary.unknownStintIds).toBe(0);
      expect(newStints(database)).toEqual([
        { id: expect.any(String), continues: null, questId: "Q2" },
      ]);
    });

    test("a stint id in matchedQuest does not put back the quest of its abandoned quest", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);
      database
        .query(
          `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
           VALUES ('QD', 'hero', 'H', 'Dropped', 'x', 1, 1, 'abandoned', '2026-09-01T00:00:00.000Z')`,
        )
        .run();
      database
        .query(
          "INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, close_reason, revision) VALUES ('SD', 'QD', 'old work', '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 'idle', 1)",
        )
        .run();

      // QD is not an open quest in the window, so SD standing for it must not revive it.
      run(
        database,
        store,
        {
          matchedStint: null,
          matchedQuest: "SD",
          newStintReason: "a comparison unrelated to the walk order work",
        },
        { ...window, recentStints: [stintSlice("SD", "QD", "2026-09-04T11:00:00.000Z")] },
      );

      expect(
        (
          database
            .query("SELECT quest_id as questId FROM stints WHERE id NOT IN ('A1', 'SD')")
            .all() as {
            questId: string | null;
          }[]
        ).map((row) => row.questId),
      ).toEqual([null]);
    });

    test("an id that is neither a stint nor a quest stays unknown", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);

      const { summary } = run(database, store, { matchedStint: "01GARBLEDGARBLEDGARBLED00" });

      expect(summary.unknownStintIds).toBe(1);
      expect(summary.stintsOpened).toBe(1);
      expect(summary.selectorRepaired).toBe(0);
    });

    test("declared mode is untouched: no repair, no counter, no confidence cap", () => {
      const database = openDatabase(":memory:");
      const { store } = seed(database);

      const { summary, logs } = run(
        database,
        store,
        { stint: "S1", matchedStint: "Q1", matchedQuest: "A1" },
        window,
        { mode: "declared" },
      );

      expect(summary.selectorRepaired).toBe(0);
      expect(logs.filter((line) => line.includes("repaired"))).toEqual([]);
      expect(tracesOn(database, "A1")).toBe(2);
      const confidence = database.query("SELECT confidence FROM traces WHERE id != 'T0'").get() as {
        confidence: number;
      };
      expect(confidence.confidence).toBe(0.9);
    });
  });

  test("matchedStint naming a dismissed stint is not reused", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);
    database
      .query(
        `INSERT INTO stints (id, quest_id, outcome, opened_at, revision, dismissed_at)
         VALUES ('A-dismissed', 'Q1', 'too short', '2026-09-04T13:00:00.000Z', 1, '2026-09-04T13:02:00.000Z')`,
      )
      .run();

    const summary = applyResult(
      store,
      database,
      window,
      {
        segments: [{ ...baseMatched, matchedStint: "A-dismissed", matchedQuest: "Q1" }],
        sessionNote: null,
      },
      {
        actor: "hook",
        askingEnabled: false,
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
        stintMinMinutes: 5,
        mode: "inferred" as const,
      },
    );

    expect(summary.unknownStintIds).toBe(1);
    const reused = database
      .query("SELECT COUNT(*) as count FROM traces WHERE stint_id = 'A-dismissed'")
      .get() as { count: number };
    expect(reused.count).toBe(0);
  });

  test("continuesStint pointing at a still-open stint reuses it instead of opening a second", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const summary = applyResult(
      store,
      database,
      window,
      {
        segments: [
          { ...baseMatched, matchedStint: null, continuesStint: "A1", matchedQuest: "Q1" },
        ],
        sessionNote: null,
      },
      {
        actor: "hook",
        askingEnabled: false,
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
        stintMinMinutes: 5,
        mode: "inferred" as const,
      },
    );

    // The outcome never stopped, so this is a plain reuse: no new row, no continues link.
    expect(summary.stintsOpened).toBe(0);
    expect(summary.unknownStintIds).toBe(0);

    const stintCount = database.query("SELECT COUNT(*) as count FROM stints").get() as {
      count: number;
    };
    expect(stintCount.count).toBe(1);

    const trace = database.query("SELECT stint_id FROM traces WHERE id != 'T0'").get() as {
      stint_id: string;
    };
    expect(trace.stint_id).toBe("A1");
  });

  test("continuesStint naming an unknown id opens a new stint with no continues link", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const summary = applyResult(
      store,
      database,
      window,
      {
        segments: [
          {
            ...baseMatched,
            matchedStint: null,
            continuesStint: "A-nope",
            belongs: true,
            guess: null,
            matchedQuest: "Q1",
          },
        ],
        sessionNote: null,
      },
      {
        actor: "hook",
        askingEnabled: false,
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
        stintMinMinutes: 5,
        mode: "inferred" as const,
      },
    );

    expect(summary.unknownStintIds).toBe(1);
    expect(summary.stintsOpened).toBe(1);

    const linked = database
      .query("SELECT COUNT(*) as count FROM stints WHERE continues IS NOT NULL")
      .get() as { count: number };
    expect(linked.count).toBe(0);
  });

  test("a switch triggered by waiting on a process branches with kind waiting", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const waiting: ClassifierResult = {
      segments: [
        {
          ...baseNew,
          startedAt: "2026-09-04T15:10:00.000Z",
          endedAt: "2026-09-04T15:20:00.000Z",
          belongs: true,
          guess: null,
          matchedQuest: null,
          proposedQuest: { title: "Side task", outcome: "fill the wait", commitment: "personal" },
          matchedStint: null,
          continuesStint: null,
          newStintReason: "started this while the build was running",
          isSwitch: true,
          trigger: "waiting on the build to finish",
          questions: [],
        },
      ],
      sessionNote: null,
    };

    applyResult(store, database, window, waiting, {
      actor: "hook",
      askingEnabled: false,
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
      mode: "inferred",
      stintMinMinutes: 5,
    });

    const branched = database
      .query("SELECT branch_kind FROM quests WHERE title = 'Side task'")
      .get() as { branch_kind: string };
    expect(branched.branch_kind).toBe("waiting");
  });
});

describe("segments of one inference window reach what earlier segments opened", () => {
  // e854515d, 2026-10-04: one window came back as four segments that all named
  // the same quest, set isSwitch false and explained in newStintReason that the
  // work was "part of the same brief execution; no separate stint needed". The
  // prompt only listed rows that existed before the window, so the model had no
  // id for the stint segment 1 opened, and every segment opened its own stint.
  const inferred = {
    actor: "backfill" as const,
    askingEnabled: false,
    now: "2026-10-18T12:00:00.000Z",
    stintMinMinutes: 5,
    mode: "inferred" as const,
  };

  /** A fresh session: nothing of its own open, the seed's Q1 offered as an open quest. */
  const freshWindow: ClassifierWindow = {
    ...window,
    sessionId: "s2",
    mode: "inferred",
    sessionOpenStints: [],
    recentStints: [],
  };

  const bounds = [
    "2026-10-04T01:02:00.524Z",
    "2026-10-04T01:13:37.328Z",
    "2026-10-04T01:18:31.933Z",
    "2026-10-04T01:20:27.190Z",
    "2026-10-04T01:21:55.550Z",
  ];

  function segmentAt(
    position: number,
    overrides: Partial<ClassifierSegment> = {},
  ): ClassifierSegment {
    return {
      startedAt: bounds[position - 1] as string,
      endedAt: bounds[position] as string,
      what: `round ${position}`,
      why: "tag contracts",
      matchedQuest: null,
      proposedQuest: null,
      matchedStint: null,
      continuesStint: null,
      newStintReason: "no listed stint fits",
      isSwitch: false,
      trigger: null,
      confidence: 0.9,
      questions: [],
      ...overrides,
    };
  }

  function run(
    database: ReturnType<typeof openDatabase>,
    store: EventStore,
    segments: ClassifierSegment[],
    candidates: ClassifierWindow = freshWindow,
  ) {
    const logs: string[] = [];
    const summary = applyResult(
      store,
      database,
      candidates,
      { segments, sessionNote: null },
      { ...inferred, log: (line) => logs.push(line) },
    );
    return { summary, logs };
  }

  /** The window's own stints, oldest first, with how many of its traces each holds. */
  const sessionStints = (database: ReturnType<typeof openDatabase>) =>
    database
      .query(
        `SELECT s.id, s.quest_id as questId, s.continues, COUNT(t.id) as traces
           FROM stints s JOIN traces t ON t.stint_id = s.id
          WHERE t.session_id = 's2'
          GROUP BY s.id ORDER BY s.opened_at, s.id`,
      )
      .all() as { id: string; questId: string | null; continues: string | null; traces: number }[];

  const proposal = {
    title: "Implement tag contracts",
    outcome: "contracts validated",
    commitment: "promised" as const,
  };

  test("four segments naming the same quest without switching land on one stint (e854515d)", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const { summary, logs } = run(database, store, [
      segmentAt(1, { matchedQuest: "Q1", newStintReason: "brief is a direct assignment" }),
      segmentAt(2, {
        matchedQuest: "Q1",
        newStintReason:
          "Review feedback is part of the same brief execution; no separate stint needed",
      }),
      segmentAt(3, {
        matchedQuest: "Q1",
        newStintReason: "Continuation of review cycle on same brief",
      }),
      segmentAt(4, { matchedQuest: "Q1", newStintReason: "Final review pass on same brief" }),
    ]);

    expect(sessionStints(database)).toEqual([
      { id: expect.any(String), questId: "Q1", continues: null, traces: 4 },
    ]);
    expect(summary.stintsOpened).toBe(1);
    expect(summary.sameWindowReuse).toBe(3);
    expect(summary.doubts).toBe(0);
    expect(logs.filter((line) => line.includes("same outcome as segment"))).toHaveLength(3);
  });

  test("a quest proposed by segment 1 carries the segments after it, not one quest-less stint each", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const { summary } = run(database, store, [
      segmentAt(1, { proposedQuest: proposal }),
      segmentAt(2),
      segmentAt(3),
      segmentAt(4),
    ]);

    const stints = sessionStints(database);
    expect(stints).toHaveLength(1);
    expect(stints[0]?.traces).toBe(4);
    const quest = database
      .query("SELECT title FROM quests WHERE id = ?")
      .get(stints[0]?.questId ?? "") as { title: string } | null;
    expect(quest?.title).toBe("Implement tag contracts");
    expect(summary.questsProposed).toBe(1);
  });

  test("segment 3 names segment 1 to come back to its stint after a switch", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const { summary } = run(database, store, [
      segmentAt(1, { matchedQuest: "Q1" }),
      segmentAt(2, {
        proposedQuest: { title: "Check email", outcome: "inbox", commitment: "personal" },
        isSwitch: true,
        trigger: "let me check email",
      }),
      segmentAt(3, {
        matchedStint: "segment:1",
        matchedQuest: "segment:1",
        newStintReason: null,
        isSwitch: true,
        trigger: "back to the contracts",
      }),
    ]);

    const stints = sessionStints(database);
    expect(stints.map((stint) => stint.traces)).toEqual([2, 1]);
    expect(stints[0]?.questId).toBe("Q1");
    expect(summary.stintsOpened).toBe(2);
    expect(summary.sameWindowReuse).toBe(1);
    // Returning to a quest already in flight in this session is not a side quest.
    expect(summary.branches).toBe(1);
  });

  test("continuesStint naming an earlier segment's still-open stint is a plain reuse", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    run(database, store, [
      segmentAt(1, { matchedQuest: "Q1" }),
      segmentAt(2, { continuesStint: "segment:1", newStintReason: null, isSwitch: true }),
    ]);

    expect(sessionStints(database)).toEqual([
      { id: expect.any(String), questId: "Q1", continues: null, traces: 2 },
    ]);
  });

  test("a new stint of segment 1's new quest: matchedQuest names the segment", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const { summary } = run(database, store, [
      segmentAt(1, { proposedQuest: proposal }),
      segmentAt(2, {
        matchedQuest: "segment:1",
        newStintReason: "writing the negative fixtures now",
        isSwitch: true,
      }),
    ]);

    const stints = sessionStints(database);
    expect(stints).toHaveLength(2);
    expect(stints[1]?.questId).toBe(stints[0]?.questId as string);
    expect(stints[0]?.questId).not.toBeNull();
    expect(summary.questsProposed).toBe(1);
  });

  test("proposing segment 1's quest again by title reuses it rather than creating a second", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const { summary, logs } = run(database, store, [
      segmentAt(1, { proposedQuest: proposal }),
      segmentAt(2, {
        proposedQuest: { ...proposal, title: "  implement TAG   contracts " },
        newStintReason: "writing the negative fixtures now",
        isSwitch: true,
      }),
    ]);

    const titles = database.query("SELECT title FROM quests WHERE id != 'Q1'").all();
    expect(titles).toEqual([{ title: "Implement tag contracts" }]);
    const stints = sessionStints(database);
    expect(stints[1]?.questId).toBe(stints[0]?.questId as string);
    expect(summary.questsProposed).toBe(1);
    expect(logs.some((line) => line.includes("again"))).toBe(true);
  });

  test("matchedQuest on the quest-less stint an earlier segment opened attaches it", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const { summary } = run(database, store, [
      segmentAt(1),
      segmentAt(2, { matchedStint: "segment:1", matchedQuest: "Q1", newStintReason: null }),
    ]);

    expect(sessionStints(database)).toEqual([
      { id: expect.any(String), questId: "Q1", continues: null, traces: 2 },
    ]);
    expect(summary.questAttachedOnMatched).toBe(1);
    expect(summary.doubts).toBe(0);
  });

  test("a quest created by segment 1 may be attached to segment 2's stint", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    // Segment 1 opened a stint for a new quest; segment 2 opened a quest-less one;
    // segment 3 says segment 2's stint serves segment 1's quest.
    const { summary } = run(database, store, [
      segmentAt(1, { proposedQuest: proposal }),
      segmentAt(2, { isSwitch: true, newStintReason: "unrelated" }),
      segmentAt(3, { matchedStint: "segment:2", matchedQuest: "segment:1", newStintReason: null }),
    ]);

    const stints = sessionStints(database);
    expect(stints).toHaveLength(2);
    expect(stints[1]?.questId).toBe(stints[0]?.questId as string);
    expect(summary.questAttachedOnMatched).toBe(1);
  });

  test("not switching but naming a different quest still opens its own stint", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);
    database
      .query(
        "INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at) SELECT 'Q2', 'hero', owner_id, 'Other', 'o', 1, 1, 'started', created_at FROM quests WHERE id = 'Q1'",
      )
      .run();
    const twoQuests: ClassifierWindow = {
      ...freshWindow,
      openQuests: [
        ...(freshWindow.openQuests ?? []),
        { id: "Q2", title: "Other", outcome: "o", lastStintAt: null },
      ],
    };

    const { summary } = run(
      database,
      store,
      [segmentAt(1, { matchedQuest: "Q1" }), segmentAt(2, { matchedQuest: "Q2" })],
      twoQuests,
    );

    expect(sessionStints(database).map((stint) => stint.questId)).toEqual(["Q1", "Q2"]);
    expect(summary.sameWindowReuse).toBe(0);
    expect(summary.doubts).toBe(0);
  });

  test("not switching after another session's quest-less stint does not attach a quest to it", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);
    database
      .query(
        "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES ('B1', NULL, 'other session', '2026-10-04T00:00:00.000Z', 1)",
      )
      .run();
    const withOther: ClassifierWindow = {
      ...freshWindow,
      recentStints: [
        {
          stintId: "B1",
          what: "other session",
          why: "x",
          questId: null,
          questTitle: null,
          openedAt: "2026-10-04T00:00:00.000Z",
          lastTraceEndedAt: "2026-10-04T00:30:00.000Z",
          closedAt: null,
          closeReason: null,
        },
      ],
    };

    run(
      database,
      store,
      [
        segmentAt(1, { matchedStint: "B1", newStintReason: null }),
        segmentAt(2, { matchedQuest: "Q1" }),
      ],
      withOther,
    );

    const b1 = database.query("SELECT quest_id as questId FROM stints WHERE id = 'B1'").get();
    expect(b1).toEqual({ questId: null });
    expect(sessionStints(database).map((stint) => [stint.id === "B1", stint.questId])).toEqual([
      [true, null],
      [false, "Q1"],
    ]);
  });

  test("the first segment of a window never falls back onto a stint from before it", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const { summary } = run(database, store, [segmentAt(1)], {
      ...freshWindow,
      sessionId: "s1",
      sessionOpenStints: window.sessionOpenStints,
    });

    expect(summary.stintsOpened).toBe(1);
    expect(summary.sameWindowReuse).toBe(0);
  });

  test("a reference to the segment itself or a later one names nothing and is never stored as an id", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const { summary } = run(database, store, [
      segmentAt(1, { matchedStint: "segment:1", matchedQuest: "segment:2", newStintReason: null }),
      segmentAt(2, { isSwitch: true, matchedQuest: "segment:5" }),
    ]);

    expect(summary.unknownStintIds).toBe(0);
    expect(summary.stintsOpened).toBe(2);
    expect(sessionStints(database).map((stint) => stint.questId)).toEqual([null, null]);
  });

  test("a garbled id after a segment that did not switch is still unknown, not a fallback", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const { summary } = run(database, store, [
      segmentAt(1, { matchedQuest: "Q1" }),
      segmentAt(2, { matchedStint: "01GARBLED", newStintReason: null }),
    ]);

    expect(summary.unknownStintIds).toBe(1);
    expect(sessionStints(database)).toHaveLength(2);
  });

  test("a quest id in a stint slot is still repaired against the window's lists (#75)", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    // The seed's A1 is this session's open stint of Q1: naming Q1 as a stint
    // reuses A1, exactly as before; the next segment, not switching, follows it.
    const { summary } = run(
      database,
      store,
      [
        segmentAt(1, { matchedStint: "Q1", newStintReason: null }),
        segmentAt(2, { matchedQuest: "Q1" }),
      ],
      { ...freshWindow, sessionId: "s1", sessionOpenStints: window.sessionOpenStints },
    );

    expect(summary.selectorRepaired).toBe(1);
    expect(summary.stintsOpened).toBe(0);
    const onA1 = database
      .query("SELECT COUNT(*) as count FROM traces WHERE stint_id = 'A1'")
      .get() as { count: number };
    expect(onA1.count).toBe(3);
  });

  test("declared mode is untouched: no segment reference is read", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const summary = applyResult(
      store,
      database,
      { ...freshWindow, mode: "declared" },
      {
        segments: [
          segmentAt(1, { stint: "new: first", belongs: true, quest: null }),
          segmentAt(2, { stint: "new: second", belongs: true, quest: null }),
        ],
        sessionNote: null,
      },
      { ...inferred, mode: "declared", log: () => {} },
    );

    expect(summary.stintsOpened).toBe(2);
    expect(summary.sameWindowReuse).toBe(0);
  });
});

describe("applyResult in declared mode", () => {
  /** A declared session: hero, quest, one open stint A1, and a declaration. */
  function seedDeclared(database: ReturnType<typeof openDatabase>, options?: { at?: string }) {
    const { store, heroId, questId } = seed(database);
    declareQuest(store, database, {
      sessionId: "s1",
      questId,
      plan: ["walk order"],
      scope: "session",
      declaredBy: "agent",
      at: options?.at ?? "2026-09-04T13:00:00.000Z",
      heroId,
    });
    return { store, heroId, questId };
  }

  const declaredWindow: ClassifierWindow = {
    ...window,
    messages: [{ ts: "2026-09-04T15:20:00.000Z", role: "user", text: "still on it" }],
    openQuests: undefined,
    recentSideQuests: undefined,
    activeQuests: [{ alias: "Q1", title: "Ship marko-ui", outcome: "86 components", plan: [] }],
    activeQuestAliases: { Q1: "Q1" },
    openStintAliases: { S1: "A1" },
    sessionOpenStints: window.sessionOpenStints.map((stint) => ({ ...stint, stintId: "S1" })),
  };

  /** What `buildWindow` produces for a session that has declared nothing yet. */
  const undeclaredWindow: ClassifierWindow = {
    ...declaredWindow,
    activeQuests: [],
    activeQuestAliases: {},
  };

  function segment(overrides: Partial<ClassifierSegment>): ClassifierSegment {
    return {
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:20:00.000Z",
      what: "fix walk order",
      why: "ship marko-ui",
      belongs: true,
      guess: null,
      quest: "Q1",
      stint: "new: a fresh stretch of work",
      isSwitch: false,
      trigger: null,
      confidence: 0.9,
      ...overrides,
    };
  }

  const declaredOptions = {
    actor: "hook" as const,
    askingEnabled: true,
    now: "2026-09-04T15:30:00.000Z",
    log: () => {},
    mode: "declared" as const,
    stintMinMinutes: 5,
  };

  test("a belonging segment gets the declared quest and asks nothing", () => {
    const database = openDatabase(":memory:");
    const { store, questId } = seedDeclared(database);

    const summary = applyResult(
      store,
      database,
      declaredWindow,
      { segments: [segment({})], sessionNote: null },
      declaredOptions,
    );

    expect(summary.doubts).toBe(0);
    expect(summary.questsProposed).toBe(0);
    const stint = database
      .query("SELECT quest_id as questId FROM stints ORDER BY opened_at DESC LIMIT 1")
      .get() as { questId: string | null };
    expect(stint.questId).toBe(questId);
    expect(
      (database.query("SELECT COUNT(*) as count FROM questions").get() as { count: number }).count,
    ).toBe(0);
  });

  test("belongs: false counts a doubt, asks a belongs question with the guess, and never reassigns", () => {
    const database = openDatabase(":memory:");
    const { store, questId } = seedDeclared(database);

    const summary = applyResult(
      store,
      database,
      declaredWindow,
      {
        segments: [
          segment({
            stint: "S1",
            belongs: false,
            quest: null,
            guess: "a competitor comparison",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    expect(summary.doubts).toBe(1);
    const question = database
      .query("SELECT kind, guess, session_id as sessionId FROM questions")
      .get() as { kind: string; guess: string | null; sessionId: string | null };
    expect(question.kind).toBe("belongs");
    expect(question.guess).toBe("a competitor comparison");
    expect(question.sessionId).toBe("s1");

    // The doubt is raised, never acted on: the stint keeps the declared quest.
    const stint = database
      .query("SELECT quest_id as questId FROM stints WHERE id = 'A1'")
      .get() as { questId: string | null };
    expect(stint.questId).toBe(questId);
  });

  test("a doubt is recorded on the trace even when asking is disabled, and logged once", () => {
    const database = openDatabase(":memory:");
    const { store } = seedDeclared(database);
    const lines: string[] = [];

    const summary = applyResult(
      store,
      database,
      declaredWindow,
      {
        segments: [
          segment({
            stint: "S1",
            belongs: false,
            quest: null,
            guess: "a competitor comparison",
          }),
        ],
        sessionNote: null,
      },
      { ...declaredOptions, askingEnabled: false, log: (line) => lines.push(line) },
    );

    expect(summary.doubts).toBe(1);
    // No question is created when asking is disabled, but the doubt is still
    // auditable straight off the trace.
    expect(
      (database.query("SELECT COUNT(*) as count FROM questions").get() as { count: number }).count,
    ).toBe(0);
    const trace = database.query("SELECT doubt FROM traces WHERE id != 'T0'").get() as {
      doubt: string | null;
    };
    expect(trace.doubt).toBe("a competitor comparison");
    expect(
      lines.some((line) =>
        /^w5 doubt: session s1 stint .+ guess "a competitor comparison"$/.test(line),
      ),
    ).toBe(true);
  });

  test("a belonging segment records a trace with no doubt", () => {
    const database = openDatabase(":memory:");
    const { store } = seedDeclared(database);

    applyResult(
      store,
      database,
      declaredWindow,
      { segments: [segment({})], sessionNote: null },
      declaredOptions,
    );

    const trace = database.query("SELECT doubt FROM traces WHERE id != 'T0'").get() as {
      doubt: string | null;
    };
    expect(trace.doubt).toBeNull();
  });

  test("declared mode never emits quest.created, quest.branched or a reassignment", () => {
    const database = openDatabase(":memory:");
    const { store } = seedDeclared(database);
    const before = (
      database.query("SELECT COUNT(*) as count FROM events").get() as { count: number }
    ).count;

    applyResult(
      store,
      database,
      declaredWindow,
      {
        segments: [
          segment({
            isSwitch: true,
            trigger: "blocked on the build",
            belongs: false,
            quest: null,
            guess: "a build fix",
          }),
          segment({
            startedAt: "2026-09-04T15:20:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            isSwitch: true,
            what: "something else",
            stint: "new: an unrelated fresh stretch of work",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    const kinds = (
      database.query("SELECT kind FROM events ORDER BY id ASC LIMIT -1 OFFSET ?").all(before) as {
        kind: string;
      }[]
    ).map((row) => row.kind);

    expect(kinds).not.toContain("quest.created");
    expect(kinds).not.toContain("quest.branched");
    expect(kinds).not.toContain("stint.assigned");
  });

  test("an unknown alias opens a new stint and counts an unknown stint id", () => {
    const database = openDatabase(":memory:");
    const { store, questId } = seedDeclared(database);

    const summary = applyResult(
      store,
      database,
      declaredWindow,
      {
        segments: [segment({ stint: "S7" })],
        sessionNote: null,
      },
      declaredOptions,
    );

    expect(summary.unknownStintIds).toBe(1);
    expect(summary.stintsOpened).toBe(1);
    const opened = database
      .query("SELECT quest_id as questId FROM stints WHERE id != 'A1'")
      .get() as { questId: string | null };
    expect(opened.questId).toBe(questId);
  });

  test("new: whose text matches an open stint of the session reuses it, like S would", () => {
    const database = openDatabase(":memory:");
    const { store, questId } = seedDeclared(database);
    const outcome = "Generate whats-new feature screenshots and e2e tests";

    const summary = applyResult(
      store,
      database,
      declaredWindow,
      { segments: [segment({ stint: `new: ${outcome}` })], sessionNote: null },
      declaredOptions,
    );
    const firstStint = database.query("SELECT id FROM stints WHERE id != 'A1'").get() as {
      id: string;
    };
    expect(summary.stintsOpened).toBe(1);

    // Same outcome text, opened again in a later window of the same session --
    // this used to open a duplicate stint every time (the Sep 2 eval saw the
    // same outcome opened as a `new:` stint up to 5 times in one session).
    const secondSummary = applyResult(
      store,
      database,
      declaredWindow,
      { segments: [segment({ stint: `new: ${outcome}` })], sessionNote: null },
      declaredOptions,
    );
    expect(secondSummary.stintsOpened).toBe(0);
    const stints = database.query("SELECT id, quest_id as questId FROM stints").all() as {
      id: string;
      questId: string | null;
    }[];
    expect(stints).toHaveLength(2); // seed's A1 plus the one reused stint
    const reused = stints.find((stint) => stint.id === firstStint.id);
    expect(reused?.questId).toBe(questId);
  });

  test("new: whose text matches a closed non-dismissed stint of the session opens a new one with continues", () => {
    const database = openDatabase(":memory:");
    const { store } = seedDeclared(database);
    const outcome = "Capture 3 admin screenshots for the release notes";

    const opened = applyResult(
      store,
      database,
      declaredWindow,
      { segments: [segment({ stint: `new: ${outcome}` })], sessionNote: null },
      declaredOptions,
    );
    expect(opened.stintsOpened).toBe(1);
    const firstStint = database.query("SELECT id FROM stints WHERE outcome = ?").get(outcome) as {
      id: string;
    };

    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "stint.closed",
        subject: firstStint.id,
        payload: { reason: "idle" },
      }),
    );

    const again = applyResult(
      store,
      database,
      declaredWindow,
      { segments: [segment({ stint: `new: ${outcome}` })], sessionNote: null },
      declaredOptions,
    );
    expect(again.stintsOpened).toBe(1);
    const stints = database
      .query(
        "SELECT id, continues as continues FROM stints WHERE outcome = ? ORDER BY opened_at ASC",
      )
      .all(outcome) as { id: string; continues: string | null }[];
    expect(stints).toHaveLength(2);
    expect(stints[1]?.continues).toBe(firstStint.id);
  });

  test("new: whose text matches nothing open or closed opens a fresh stint", () => {
    const database = openDatabase(":memory:");
    const { store } = seedDeclared(database);

    const summary = applyResult(
      store,
      database,
      declaredWindow,
      {
        segments: [segment({ stint: "new: a genuinely fresh stretch of work" })],
        sessionNote: null,
      },
      declaredOptions,
    );

    expect(summary.stintsOpened).toBe(1);
    const stint = database
      .query("SELECT outcome, continues as continues FROM stints WHERE id != 'A1'")
      .get() as { outcome: string; continues: string | null };
    expect(stint.outcome).toBe("a genuinely fresh stretch of work");
    expect(stint.continues).toBeNull();
  });

  test("new: reuse matching is trim/whitespace/case-insensitive on both sides", () => {
    const database = openDatabase(":memory:");
    const { store, questId } = seedDeclared(database);

    const opened = applyResult(
      store,
      database,
      declaredWindow,
      {
        segments: [segment({ stint: "new: Capture   3  admin   screenshots" })],
        sessionNote: null,
      },
      declaredOptions,
    );
    expect(opened.stintsOpened).toBe(1);
    const firstStint = database.query("SELECT id FROM stints WHERE id != 'A1'").get() as {
      id: string;
    };

    // Same outcome, different case and internal whitespace -- plausible
    // model variance across windows, not a new outcome.
    const again = applyResult(
      store,
      database,
      declaredWindow,
      {
        segments: [segment({ stint: "new: capture 3 ADMIN screenshots" })],
        sessionNote: null,
      },
      declaredOptions,
    );
    expect(again.stintsOpened).toBe(0);

    const stints = database.query("SELECT id, quest_id as questId FROM stints").all() as {
      id: string;
      questId: string | null;
    }[];
    expect(stints).toHaveLength(2);
    const reused = stints.find((stint) => stint.id === firstStint.id);
    expect(reused?.questId).toBe(questId);
  });

  test("an alias is mapped back to the real stint id it stands for", () => {
    const database = openDatabase(":memory:");
    const { store } = seedDeclared(database);

    const summary = applyResult(
      store,
      database,
      declaredWindow,
      {
        segments: [segment({ stint: "S1" })],
        sessionNote: null,
      },
      declaredOptions,
    );

    // The alias resolved, so nothing new was opened and the trace joined A1.
    expect(summary.stintsOpened).toBe(0);
    expect(summary.unknownStintIds).toBe(0);
    const trace = database
      .query("SELECT stint_id as stintId FROM traces WHERE id != 'T0'")
      .get() as { stintId: string };
    expect(trace.stintId).toBe("A1");
  });

  test("a session with no declaration records traces with no quest and asks to declare once", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    const summary = applyResult(
      store,
      database,
      undeclaredWindow,
      {
        segments: [
          segment({}),
          segment({
            startedAt: "2026-09-04T15:20:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            stint: "new: an unrelated fresh stretch of work",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    expect(summary.stintsOpened).toBe(2);
    const opened = database
      .query("SELECT quest_id as questId FROM stints WHERE id != 'A1'")
      .all() as { questId: string | null }[];
    expect(opened).toHaveLength(2);
    expect(opened.every((stint) => stint.questId === null)).toBe(true);

    // One gap, one question -- not one per segment.
    const questions = database.query("SELECT kind FROM questions").all() as { kind: string }[];
    expect(questions).toHaveLength(1);
    expect(questions[0]?.kind).toBe("declare");
  });

  test("a declare question is suppressed when the window's undeclared time is below stintMinMinutes", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    applyResult(
      store,
      database,
      undeclaredWindow,
      {
        segments: [
          segment({ startedAt: "2026-09-04T15:00:00.000Z", endedAt: "2026-09-04T15:02:00.000Z" }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    const asked = database.query("SELECT kind FROM questions WHERE state = 'watching'").all() as {
      kind: string;
    }[];
    expect(asked.some((q) => q.kind === "declare")).toBe(false);
  });

  test("a declare question is asked once undeclared time meets stintMinMinutes", () => {
    const database = openDatabase(":memory:");
    const { store } = seed(database);

    applyResult(
      store,
      database,
      undeclaredWindow,
      {
        segments: [
          segment({ startedAt: "2026-09-04T15:00:00.000Z", endedAt: "2026-09-04T15:06:00.000Z" }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    const asked = database.query("SELECT kind FROM questions WHERE state = 'watching'").all() as {
      kind: string;
    }[];
    expect(asked.some((q) => q.kind === "declare")).toBe(true);
  });

  test("a subagent's doubt is addressed to the parent session", () => {
    const database = openDatabase(":memory:");
    const { store, heroId } = seed(database);
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
         VALUES ('Q2', 'hero', ?, 'Verify the fix', 'prove it', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
      )
      .run(heroId);
    declareQuest(store, database, {
      sessionId: "s1",
      parentSessionId: "parent",
      questId: "Q2",
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-04T13:00:00.000Z",
      heroId,
    });

    const summary = applyResult(
      store,
      database,
      {
        ...declaredWindow,
        parentActiveQuests: [{ alias: "PQ1", title: "Ship marko-ui", outcome: null, plan: [] }],
        parentActiveQuestAliases: { PQ1: "Q1" },
        activeQuests: [{ alias: "Q1", title: "Verify the fix", outcome: "prove it", plan: [] }],
        activeQuestAliases: { Q1: "Q2" },
      },
      {
        segments: [
          // A doubted segment names no quest, so its stint carries none; the
          // belonging one is what shows the subagent's own quest is used.
          segment({ belongs: false, quest: null, guess: "unrelated refactor" }),
          segment({
            startedAt: "2026-09-04T15:20:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            quest: "Q1",
            stint: "new: verifying the fix",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    expect(summary.doubts).toBe(1);
    const question = database.query("SELECT session_id as sessionId FROM questions").get() as {
      sessionId: string | null;
    };
    expect(question.sessionId).toBe("parent");

    // The subagent's own quest, not the parent's, is what its work is attributed to.
    const stint = database
      .query(
        "SELECT quest_id as questId FROM stints WHERE id != 'A1' ORDER BY opened_at DESC LIMIT 1",
      )
      .get() as { questId: string | null };
    expect(stint.questId).toBe("Q2");
  });

  test("a P selector opens a plan stint carrying its plan_index, and reuses it after", () => {
    const database = openDatabase(":memory:");
    const { store, questId } = seedDeclared(database);

    const planWindow: ClassifierWindow = {
      ...declaredWindow,
      activeQuests: [
        { alias: "Q1", title: "Ship marko-ui", outcome: "86 components", plan: ["walk order"] },
      ],
      planAliases: { "P1.1": "walk order" },
    };

    const summary = applyResult(
      store,
      database,
      planWindow,
      {
        segments: [
          segment({ quest: "Q1", stint: "P1.1" }),
          segment({
            startedAt: "2026-09-04T15:20:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            quest: "Q1",
            stint: "P1.1",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    // Two segments naming the same plan item share one stint, not two.
    expect(summary.stintsOpened).toBe(1);
    const opened = database
      .query(
        "SELECT id, quest_id as questId, plan_index as planIndex, outcome FROM stints WHERE plan_index IS NOT NULL",
      )
      .all() as { id: string; questId: string | null; planIndex: string; outcome: string }[];
    expect(opened.length).toBe(1);
    expect(opened[0]?.planIndex).toBe("P1.1");
    expect(opened[0]?.questId).toBe(questId);
    expect(opened[0]?.outcome).toBe("walk order");

    const traces = database
      .query("SELECT stint_id as stintId FROM traces WHERE id != 'T0'")
      .all() as { stintId: string }[];
    const planStintId = opened[0]?.id as string;
    expect(traces.map((trace) => trace.stintId)).toEqual([planStintId, planStintId]);
  });

  test("each active quest's segments land on their own quest, and nothing creates a quest", () => {
    const database = openDatabase(":memory:");
    const { store, heroId, questId } = seedDeclared(database);
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
         VALUES ('Q2', 'hero', ?, 'Fix the flake', 'green suite', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
      )
      .run(heroId);
    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q2",
      plan: ["quarantine it"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T13:30:00.000Z",
      heroId,
    });

    const twoQuestWindow: ClassifierWindow = {
      ...declaredWindow,
      activeQuests: [
        { alias: "Q1", title: "Ship marko-ui", outcome: "86 components", plan: [] },
        { alias: "Q2", title: "Fix the flake", outcome: "green suite", plan: ["quarantine it"] },
      ],
      activeQuestAliases: { Q1: questId, Q2: "Q2" },
      planAliases: { "P2.1": "quarantine it" },
    };

    const before = (
      database.query("SELECT COUNT(*) as count FROM quests").get() as { count: number }
    ).count;

    applyResult(
      store,
      database,
      twoQuestWindow,
      {
        segments: [
          segment({ quest: "Q1", stint: "new: chase the walk order bug" }),
          segment({
            startedAt: "2026-09-04T15:20:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            quest: "Q2",
            stint: "P2.1",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    const opened = database
      .query(
        "SELECT quest_id as questId, outcome, plan_index as planIndex FROM stints WHERE id != 'A1' ORDER BY opened_at ASC",
      )
      .all() as { questId: string | null; outcome: string; planIndex: string | null }[];

    expect(opened.map((stint) => stint.questId)).toEqual([questId, "Q2"]);
    expect(opened[0]?.outcome).toBe("chase the walk order bug");
    expect(opened[0]?.planIndex).toBeNull();
    expect(opened[1]?.planIndex).toBe("P2.1");
    expect(
      (database.query("SELECT COUNT(*) as count FROM quests").get() as { count: number }).count,
    ).toBe(before);
  });

  test("an amended plan item opens a new stint instead of reusing the old alias's", () => {
    const database = openDatabase(":memory:");
    const { store, heroId, questId } = seedDeclared(database);

    const windowFor = (planItem: string): ClassifierWindow => ({
      ...declaredWindow,
      activeQuests: [
        { alias: "Q1", title: "Ship marko-ui", outcome: "86 components", plan: [planItem] },
      ],
      planAliases: { "P1.1": planItem },
    });

    applyResult(
      store,
      database,
      windowFor("walk order"),
      { segments: [segment({ quest: "Q1", stint: "P1.1" })], sessionNote: null },
      declaredOptions,
    );

    const first = database
      .query("SELECT id, outcome FROM stints WHERE plan_index = 'P1.1'")
      .get() as { id: string; outcome: string };
    expect(first.outcome).toBe("walk order");

    // The executor amends the plan: P1.1 now names a different outcome, so the
    // stint standing for the old item must not absorb the new one's traces.
    declareQuest(store, database, {
      sessionId: "s1",
      questId,
      plan: ["quarantine the flaky test"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T15:19:00.000Z",
      heroId,
    });

    const summary = applyResult(
      store,
      database,
      windowFor("quarantine the flaky test"),
      {
        segments: [
          segment({
            startedAt: "2026-09-04T15:20:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            quest: "Q1",
            stint: "P1.1",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    expect(summary.stintsOpened).toBe(1);
    const stints = database
      .query(
        "SELECT id, outcome, closed_at as closedAt FROM stints WHERE plan_index = 'P1.1' ORDER BY opened_at ASC",
      )
      .all() as { id: string; outcome: string; closedAt: string | null }[];
    expect(stints.map((stint) => stint.outcome)).toEqual([
      "walk order",
      "quarantine the flaky test",
    ]);

    // The old stint is left exactly as it was -- not closed, not reworded.
    expect(stints[0]?.id).toBe(first.id);
    expect(stints[0]?.closedAt).toBeNull();
    const oldTraces = database
      .query("SELECT COUNT(*) as count FROM traces WHERE stint_id = ?")
      .get(first.id) as { count: number };
    expect(oldTraces.count).toBe(1);
  });

  test("a still-open plan item reuses its stint after an insertion shifts its alias", () => {
    const database = openDatabase(":memory:");
    const { store, heroId, questId } = seedDeclared(database);

    const windowFor = (plan: string[]): ClassifierWindow => ({
      ...declaredWindow,
      activeQuests: [{ alias: "Q1", title: "Ship marko-ui", outcome: "86 components", plan }],
      planAliases: Object.fromEntries(plan.map((item, index) => [`P1.${index + 1}`, item])),
    });

    applyResult(
      store,
      database,
      windowFor(["walk order"]),
      { segments: [segment({ quest: "Q1", stint: "P1.1" })], sessionNote: null },
      declaredOptions,
    );

    const first = database.query("SELECT id FROM stints WHERE plan_item = 'walk order'").get() as {
      id: string;
    };

    // A new item is inserted ahead of the unfinished one: "walk order" is now
    // P1.2. It is the same outcome, still in flight, so it keeps its stint --
    // the alias moved, the plan line did not.
    declareQuest(store, database, {
      sessionId: "s1",
      questId,
      plan: ["new first item", "walk order"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T15:19:00.000Z",
      heroId,
    });

    const summary = applyResult(
      store,
      database,
      windowFor(["new first item", "walk order"]),
      {
        segments: [
          segment({
            startedAt: "2026-09-04T15:20:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            quest: "Q1",
            stint: "P1.2",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    expect(summary.stintsOpened).toBe(0);
    expect(
      (
        database
          .query("SELECT COUNT(*) as count FROM stints WHERE plan_item = 'walk order'")
          .get() as { count: number }
      ).count,
    ).toBe(1);
    const traces = database
      .query("SELECT COUNT(*) as count FROM traces WHERE stint_id = ?")
      .get(first.id) as { count: number };
    expect(traces.count).toBe(2);
  });

  test("two segments naming a shifted plan item in one window share its stint", () => {
    const database = openDatabase(":memory:");
    const { store } = seedDeclared(database);

    const planWindow: ClassifierWindow = {
      ...declaredWindow,
      activeQuests: [
        {
          alias: "Q1",
          title: "Ship marko-ui",
          outcome: "86 components",
          plan: ["first", "walk order"],
        },
      ],
      planAliases: { "P1.1": "first", "P1.2": "walk order" },
    };

    const summary = applyResult(
      store,
      database,
      planWindow,
      {
        segments: [
          segment({ quest: "Q1", stint: "P1.2" }),
          segment({
            startedAt: "2026-09-04T15:20:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            quest: "Q1",
            stint: "P1.2",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    expect(summary.stintsOpened).toBe(1);
    const opened = database
      .query("SELECT plan_index as planIndex, plan_item as planItem FROM stints WHERE id != 'A1'")
      .all() as { planIndex: string; planItem: string }[];
    expect(opened).toHaveLength(1);
    // The alias is still recorded as written, for display and audit.
    expect(opened[0]?.planIndex).toBe("P1.2");
    expect(opened[0]?.planItem).toBe("walk order");
  });

  test("a plan item of another session does not leak into this session's reuse", () => {
    const database = openDatabase(":memory:");
    const { store, questId } = seedDeclared(database);

    const planWindow: ClassifierWindow = {
      ...declaredWindow,
      activeQuests: [
        { alias: "Q1", title: "Ship marko-ui", outcome: "86 components", plan: ["walk order"] },
      ],
      planAliases: { "P1.1": "walk order" },
    };

    // Another session already has an open stint for the same plan line of the
    // same quest. A plan item is one stint *per session*, so this one is not it.
    database
      .query(
        "INSERT INTO stints (id, quest_id, outcome, opened_at, revision, plan_index, plan_item) VALUES ('A-other', ?, 'walk order', '2026-09-04T09:00:00.000Z', 1, 'P1.1', 'walk order')",
      )
      .run(questId);
    database
      .query(
        `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
         VALUES ('T-other', 'A-other', 'claude-code', 'personal/marko-ui', 'session', '2026-09-04T09:00:00.000Z', '2026-09-04T09:30:00.000Z', 'hero', 'walk order', 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 'other-session', '2026-09-04T09:30:00.000Z')`,
      )
      .run();

    const summary = applyResult(
      store,
      database,
      planWindow,
      { segments: [segment({ quest: "Q1", stint: "P1.1" })], sessionNote: null },
      declaredOptions,
    );

    expect(summary.stintsOpened).toBe(1);
    const traces = database
      .query("SELECT COUNT(*) as count FROM traces WHERE stint_id = 'A-other'")
      .get() as { count: number };
    expect(traces.count).toBe(1);
  });

  test("a plan item still reuses its stint when the plan is re-declared unchanged", () => {
    const database = openDatabase(":memory:");
    const { store, heroId, questId } = seedDeclared(database);

    const planWindow: ClassifierWindow = {
      ...declaredWindow,
      activeQuests: [
        { alias: "Q1", title: "Ship marko-ui", outcome: "86 components", plan: ["walk order"] },
      ],
      planAliases: { "P1.1": "walk order" },
    };

    applyResult(
      store,
      database,
      planWindow,
      { segments: [segment({ quest: "Q1", stint: "P1.1" })], sessionNote: null },
      declaredOptions,
    );

    // Re-declared with the same plan: an amendment elsewhere, not to this item.
    declareQuest(store, database, {
      sessionId: "s1",
      questId,
      plan: ["walk order"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T15:19:00.000Z",
      heroId,
    });

    const summary = applyResult(
      store,
      database,
      planWindow,
      {
        segments: [
          segment({
            startedAt: "2026-09-04T15:20:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            quest: "Q1",
            stint: "P1.1",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    expect(summary.stintsOpened).toBe(0);
    expect(
      (
        database.query("SELECT COUNT(*) as count FROM stints WHERE plan_index = 'P1.1'").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
  });

  test("the latest plan declared for a quest in the session is the one that is offered", () => {
    const database = openDatabase(":memory:");
    const { store, heroId, questId } = seedDeclared(database);
    declareQuest(store, database, {
      sessionId: "s1",
      questId,
      plan: ["a better plan"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T14:00:00.000Z",
      heroId,
    });

    const amendedWindow: ClassifierWindow = {
      ...declaredWindow,
      activeQuests: [
        { alias: "Q1", title: "Ship marko-ui", outcome: "86 components", plan: ["a better plan"] },
      ],
      planAliases: { "P1.1": "a better plan" },
    };

    applyResult(
      store,
      database,
      amendedWindow,
      { segments: [segment({ quest: "Q1", stint: "P1.1" })], sessionNote: null },
      declaredOptions,
    );

    const opened = database.query("SELECT outcome FROM stints WHERE plan_index = 'P1.1'").get() as {
      outcome: string;
    };
    expect(opened.outcome).toBe("a better plan");
  });

  test("returning to a plan stint after it closed opens a stint that continues it", () => {
    const database = openDatabase(":memory:");
    const { store, questId } = seedDeclared(database);

    const planWindow: ClassifierWindow = {
      ...declaredWindow,
      activeQuests: [
        { alias: "Q1", title: "Ship marko-ui", outcome: "86 components", plan: ["walk order"] },
      ],
      planAliases: { "P1.1": "walk order" },
    };

    applyResult(
      store,
      database,
      planWindow,
      { segments: [segment({ quest: "Q1", stint: "P1.1" })], sessionNote: null },
      declaredOptions,
    );

    const first = database.query("SELECT id FROM stints WHERE plan_index = 'P1.1'").get() as {
      id: string;
    };
    // An idle gap closed it; the executor comes back to the same plan item.
    database
      .query("UPDATE stints SET closed_at = '2026-09-04T15:25:00.000Z' WHERE id = ?")
      .run(first.id);

    applyResult(
      store,
      database,
      planWindow,
      {
        segments: [
          segment({
            startedAt: "2026-09-04T15:20:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            quest: "Q1",
            stint: "P1.1",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    const stints = database
      .query(
        "SELECT id, continues, quest_id as questId FROM stints WHERE plan_index = 'P1.1' ORDER BY opened_at ASC",
      )
      .all() as { id: string; continues: string | null; questId: string | null }[];

    expect(stints.length).toBe(2);
    expect(stints[1]?.continues).toBe(first.id);
    expect(stints[1]?.questId).toBe(questId);
  });

  test("an S selector records on the open stint under the quest the segment names", () => {
    const database = openDatabase(":memory:");
    const { store, questId } = seedDeclared(database);

    const summary = applyResult(
      store,
      database,
      declaredWindow,
      { segments: [segment({ quest: "Q1", stint: "S1" })], sessionNote: null },
      declaredOptions,
    );

    expect(summary.stintsOpened).toBe(0);
    const trace = database
      .query("SELECT stint_id as stintId FROM traces WHERE id != 'T0'")
      .get() as { stintId: string };
    expect(trace.stintId).toBe("A1");
    expect(
      (
        database.query("SELECT quest_id as questId FROM stints WHERE id = 'A1'").get() as {
          questId: string | null;
        }
      ).questId,
    ).toBe(questId);
  });

  test("an empty plan item is stored, not silently turned into NULL", () => {
    const database = openDatabase(":memory:");
    const { store } = seedDeclared(database);

    // `--plan` filters empty parts today, so this is a guard on the projection
    // rather than a reachable CLI state: an empty string is a value, and a
    // truthiness check would store NULL for it.
    openStintContinuing(store, database, {
      outcome: "walk order",
      at: "2026-09-04T15:00:00.000Z",
      actor: "hook",
      planIndex: "P1.1",
      planItem: "",
    });

    const opened = database
      .query("SELECT plan_index as planIndex, plan_item as planItem FROM stints WHERE id != 'A1'")
      .get() as { planIndex: string | null; planItem: string | null };
    expect(opened.planIndex).toBe("P1.1");
    expect(opened.planItem).toBe("");
  });

  test("a new: selector opens a stint whose outcome is the text after the prefix", () => {
    const database = openDatabase(":memory:");
    const { store } = seedDeclared(database);

    applyResult(
      store,
      database,
      declaredWindow,
      {
        segments: [segment({ quest: "Q1", stint: "new: Investigate the flaky test" })],
        sessionNote: null,
      },
      declaredOptions,
    );

    const opened = database
      .query("SELECT outcome, plan_index as planIndex FROM stints WHERE id != 'A1'")
      .get() as { outcome: string; planIndex: string | null };
    expect(opened.outcome).toBe("Investigate the flaky test");
    expect(opened.planIndex).toBeNull();
  });

  test("a subagent may place a segment on one of the parent's active quests", () => {
    const database = openDatabase(":memory:");
    const { store, heroId, questId } = seed(database);
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
         VALUES ('Q2', 'hero', ?, 'Verify the fix', 'prove it', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
      )
      .run(heroId);
    declareQuest(store, database, {
      sessionId: "parent",
      questId,
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T12:00:00.000Z",
      heroId,
    });
    declareQuest(store, database, {
      sessionId: "s1",
      parentSessionId: "parent",
      questId: "Q2",
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-04T13:00:00.000Z",
      heroId,
    });

    applyResult(
      store,
      database,
      {
        ...declaredWindow,
        activeQuests: [{ alias: "Q1", title: "Verify the fix", outcome: "prove it", plan: [] }],
        activeQuestAliases: { Q1: "Q2" },
        parentActiveQuests: [
          { alias: "PQ1", title: "Ship marko-ui", outcome: "86 components", plan: [] },
        ],
        parentActiveQuestAliases: { PQ1: questId },
      },
      {
        segments: [
          segment({ quest: "Q1", stint: "new: verifying the fix" }),
          segment({
            startedAt: "2026-09-04T15:20:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            quest: "PQ1",
            stint: "new: a chunk of the lead's own quest",
          }),
        ],
        sessionNote: null,
      },
      declaredOptions,
    );

    const opened = database
      .query("SELECT quest_id as questId FROM stints WHERE id != 'A1' ORDER BY opened_at ASC")
      .all() as { questId: string | null }[];
    expect(opened.map((stint) => stint.questId)).toEqual(["Q2", questId]);
  });

  test("a doubt is still counted when asking is disabled, without asking", () => {
    const database = openDatabase(":memory:");
    const { store } = seedDeclared(database);

    const summary = applyResult(
      store,
      database,
      declaredWindow,
      {
        segments: [segment({ belongs: false, quest: null, guess: "something else" })],
        sessionNote: null,
      },
      { ...declaredOptions, askingEnabled: false },
    );

    expect(summary.doubts).toBe(1);
    expect(
      (database.query("SELECT COUNT(*) as count FROM questions").get() as { count: number }).count,
    ).toBe(0);
  });
});
