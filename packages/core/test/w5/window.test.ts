import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { declareQuest } from "../../src/intent/declarations";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { buildWindow, findSessionFile } from "../../src/w5/window";

registerAllProjections();

const memoryInput = {
  maxMessages: 50,
  memoryHours: 8,
  memoryStints: 10,
  memoryQuests: 20,
  overlapMessages: 3,
};

function seedSession(database: ReturnType<typeof openDatabase>) {
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/marko-ui', 'personal', 'marko-ui', 'marko-ui', 'main',
               '2026-09-04T14:00:00.000Z', '2026-09-04T15:20:00.000Z', 3, 0, '[]', 'host', '2026-09-04T15:20:00.000Z')`,
    )
    .run();

  const insertMessage = database.query(
    `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
     VALUES (?, 's1', ?, ?, 0, ?)`,
  );
  insertMessage.run("m0", "2026-09-04T13:50:00.000Z", "user", "even older message");
  insertMessage.run("m1", "2026-09-04T14:00:00.000Z", "user", "old message before cut");
  insertMessage.run("m2", "2026-09-04T15:00:00.000Z", "user", "fix the walk order bug");
  insertMessage.run("m3", "2026-09-04T15:20:00.000Z", "user", "wait, what does Astryx do?");
}

/** An earlier session in the same project, whose stint was closed by session end. */
function seedEarlierSession(database: ReturnType<typeof openDatabase>) {
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s0', '/c', 'p', '/c/p/s0.jsonl', '/w/marko-ui', 'personal', 'marko-ui', 'earlier', 'main',
               '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 1, 0, '[]', 'host', '2026-09-04T11:00:00.000Z')`,
    )
    .run();
  database
    .query(
      `INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, close_reason, revision)
       VALUES ('A0', 'Q1', 'fixing walk order', '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 'session_end', 1)`,
    )
    .run();
  database
    .query(
      `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('T00', 'A0', 'claude-code', 'personal/marko-ui', 'session', '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z', 'hero', 'fixing walk order', 'ship it', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's0', '2026-09-04T11:00:00.000Z')`,
    )
    .run();
}

function seedOpenStint(database: ReturnType<typeof openDatabase>) {
  database
    .query(
      "INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at) VALUES ('Q1', 'hero', 'H1', 'Ship marko-ui', '86 components', 1, 1, 'started', '2026-09-01T00:00:00.000Z')",
    )
    .run();
  database
    .query(
      "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES ('A1', 'Q1', 'fixing walk order', '2026-09-04T14:00:00.000Z', 1)",
    )
    .run();
  database
    .query(
      `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('T1', 'A1', 'claude-code', 'personal/marko-ui', 'session', '2026-09-04T14:00:00.000Z', '2026-09-04T14:30:00.000Z', 'hero', 'fixing walk order', 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's1', '2026-09-04T14:30:00.000Z')`,
    )
    .run();
}

describe("window builder", () => {
  test("findSessionFile returns the file path", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    expect(findSessionFile(database, "s1")).toBe("/c/p/s1.jsonl");
    expect(findSessionFile(database, "missing")).toBeNull();
  });

  test("buildWindow shapes messages, open quests, sinceTs cut and maxMessages cap", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);

    const windowSinceCut = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });
    expect(windowSinceCut.messages.map((m) => m.text)).toEqual([
      "fix the walk order bug",
      "wait, what does Astryx do?",
    ]);
    // Declared mode has no quest lists at all; they come back only for the
    // inference fallback.
    expect(windowSinceCut.openQuests).toBeUndefined();
    expect(windowSinceCut.recentSideQuests).toBeUndefined();

    const inferredWindow = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      mode: "inferred",
      ...memoryInput,
    });
    expect(inferredWindow.openQuests).toEqual([
      {
        id: "Q1",
        title: "Ship marko-ui",
        outcome: "86 components",
        lastStintAt: "2026-09-04T14:00:00.000Z",
      },
    ]);

    const windowCapped = buildWindow(database, {
      sessionId: "s1",
      sinceTs: null,
      ...memoryInput,
      maxMessages: 2,
    });
    expect(windowCapped.messages.map((m) => m.text)).toEqual([
      "fix the walk order bug",
      "wait, what does Astryx do?",
    ]);
  });

  test("sessionOpenActivities carries this session's still-open stint with its last trace end", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });

    // The row carries the alias; the real id lives only in openStintAliases.
    expect(window.openStintAliases).toEqual({ S1: "A1" });
    expect(window.sessionOpenStints).toEqual([
      {
        stintId: "S1",
        what: "fixing walk order",
        why: "ship",
        questId: "Q1",
        questTitle: "Ship marko-ui",
        openedAt: "2026-09-04T14:00:00.000Z",
        lastTraceEndedAt: "2026-09-04T14:30:00.000Z",
      },
    ]);
  });

  test("buildWindow never offers a dismissed stint as a candidate", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    database
      .query(
        "INSERT INTO stints (id, quest_id, outcome, opened_at, revision, dismissed_at) VALUES ('A-dismissed', 'Q1', 'a quick check', '2026-09-04T14:05:00.000Z', 1, '2026-09-04T14:08:00.000Z')",
      )
      .run();
    database
      .query(
        `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
         VALUES ('T2', 'A-dismissed', 'claude-code', 'personal/marko-ui', 'session', '2026-09-04T14:05:00.000Z', '2026-09-04T14:08:00.000Z', 'hero', 'a quick check', 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's1', '2026-09-04T14:08:00.000Z')`,
      )
      .run();

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });

    expect(window.sessionOpenStints.map((s) => s.stintId)).toEqual(["S1"]);
    expect(Object.values(window.openStintAliases)).not.toContain("A-dismissed");
  });

  test("recentActivities carries a closed stint from an earlier session in the same project", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedEarlierSession(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });

    expect(window.openStintAliases.S2).toBe("A0");
    expect(window.recentStints).toEqual([
      {
        stintId: "S2",
        what: "fixing walk order",
        why: "ship it",
        questId: "Q1",
        questTitle: "Ship marko-ui",
        openedAt: "2026-09-04T10:00:00.000Z",
        lastTraceEndedAt: "2026-09-04T11:00:00.000Z",
        closedAt: "2026-09-04T11:00:00.000Z",
        closeReason: "session_end",
      },
    ]);
  });

  test("recentActivities drops stints older than memoryHours and obeys memoryActivities", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedEarlierSession(database);

    const stale = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      memoryHours: 1,
    });
    expect(stale.recentStints).toEqual([]);

    const capped = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      memoryStints: 0,
    });
    expect(capped.recentStints).toEqual([]);
  });

  test("recentSideQuests carries branched quests with their trigger (inference fallback only)", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at, deviates_from_stint_id, branched_at, trigger)
         VALUES ('Q2', 'hero', 'H1', 'Compare Astryx', 'see what they claim', 0, 1, 'started', '2026-09-04T12:00:00.000Z', 'A1', '2026-09-04T12:00:00.000Z', 'what does Astryx do for agents?')`,
      )
      .run();

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      mode: "inferred",
      ...memoryInput,
    });

    expect(window.recentSideQuests).toEqual([
      { id: "Q2", title: "Compare Astryx", trigger: "what does Astryx do for agents?" },
    ]);
  });

  test("recentSideQuests includes a side quest that deviates from a quest rather than a stint", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    const store = new EventStore(database);
    const append = (event: Parameters<EventStore["append"]>[0]) =>
      applyIncremental(database, store.append(event));
    append({
      actor: "hero",
      kind: "quest.created",
      subject: "Q3",
      at: "2026-09-04T12:30:00.000Z",
      payload: { owner: { kind: "hero", id: "H1" }, title: "Silence the hook", confirmed: false },
    });
    // What `quest declare --new ... --deviates-from <quest>` writes: no stint,
    // only `quests.deviates_from_quest_id`.
    append({
      actor: "hero",
      kind: "quest.branched",
      subject: "Q3",
      at: "2026-09-04T12:30:00.000Z",
      payload: { deviates_from_quest: "Q1", trigger: "the hook prints noise", kind: "curiosity" },
    });
    expect(
      database
        .query("SELECT deviates_from_stint_id, deviates_from_quest_id FROM quests WHERE id = 'Q3'")
        .get(),
    ).toEqual({ deviates_from_stint_id: null, deviates_from_quest_id: "Q1" });

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      mode: "inferred",
      ...memoryInput,
    });

    expect(window.recentSideQuests).toEqual([
      { id: "Q3", title: "Silence the hook", trigger: "the hook prints noise" },
    ]);
  });

  test("overlapMessages carries the messages just before the cut, and messages excludes them", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      overlapMessages: 1,
    });

    expect(window.overlapMessages.map((m) => m.text)).toEqual(["old message before cut"]);
    expect(window.messages.map((m) => m.text)).not.toContain("old message before cut");
  });

  test("previousSessionNote comes from w5_runs", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);

    const before = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });
    expect(before.previousSessionNote).toBeNull();

    database
      .query(
        "INSERT INTO w5_runs (session_id, last_run_at, last_message_ts, session_note) VALUES ('s1', '2026-09-04T14:30:00.000Z', '2026-09-04T14:30:00.000Z', 'heading back to the walk order bug')",
      )
      .run();

    const after = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });
    expect(after.previousSessionNote).toBe("heading back to the walk order bug");
  });
});

describe("candidate time bounds", () => {
  /**
   * A stint from a *later* session in the same project. Backfill walks
   * history, so when the window under classification is an earlier one this
   * stint has not happened yet from that window's point of view.
   */
  function seedFutureStint(database: ReturnType<typeof openDatabase>) {
    database
      .query(
        `INSERT INTO claude_sessions
          (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
           started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s2', '/c', 'p', '/c/p/s2.jsonl', '/w/marko-ui', 'personal', 'marko-ui', 'later', 'main',
                 '2026-09-06T10:00:00.000Z', '2026-09-06T11:00:00.000Z', 1, 0, '[]', 'host', '2026-09-06T11:00:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, close_reason, revision)
         VALUES ('A9', 'Q1', 'work from two days later', '2026-09-06T10:00:00.000Z', '2026-09-06T11:00:00.000Z', 'session_end', 1)`,
      )
      .run();
    database
      .query(
        `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
         VALUES ('T9', 'A9', 'claude-code', 'personal/marko-ui', 'session', '2026-09-06T10:00:00.000Z', '2026-09-06T11:00:00.000Z', 'hero', 'later work', 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', 's2', '2026-09-06T11:00:00.000Z')`,
      )
      .run();
  }

  test("a stint opened after the window is not offered as a candidate", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedEarlierSession(database);
    seedFutureStint(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      memoryHours: 240,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    // Rows carry aliases now, so the real ids are read back through the map.
    const offered = window.recentStints.map((stint) => window.openStintAliases[stint.stintId]);
    expect(offered).not.toContain("A9");
    // The genuinely earlier stint is still offered, so the bound is not just
    // emptying the slice.
    expect(offered).toContain("A0");
  });

  test("without a windowEnd bound the future stint would be offered", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedFutureStint(database);

    // `windowEnd` defaults to now, which is after the seeded 2026 timestamps only
    // if the clock says so; pass an explicit bound past the future stint to
    // show the filter is what excludes it above, not some other clause.
    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      memoryHours: 240,
      windowEnd: "2026-09-07T00:00:00.000Z",
    });

    expect(window.recentStints.map((stint) => window.openStintAliases[stint.stintId])).toContain(
      "A9",
    );
  });

  test("an open stint of this session opened after the window is not offered", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: null,
      ...memoryInput,
      // A1 opened at 14:00; this window ended before that.
      windowEnd: "2026-09-04T13:55:00.000Z",
    });

    expect(window.sessionOpenStints).toEqual([]);
  });

  test("a closed stint older than memory_hours is still excluded", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedEarlierSession(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      // A0 closed at 11:00, more than an hour before the 14:30 reference.
      memoryHours: 1,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(
      window.recentStints.map((stint) => window.openStintAliases[stint.stintId]),
    ).not.toContain("A0");
  });
});

describe("declared quests in the window", () => {
  function seedHeroAndQuest(database: ReturnType<typeof openDatabase>) {
    const store = new EventStore(database);
    database
      .query(
        "INSERT INTO heroes (id, name, created_at) VALUES ('H1', 'Saulo', '2026-09-01T00:00:00.000Z')",
      )
      .run();
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
         VALUES ('Q1', 'hero', 'H1', 'Ship marko-ui', '86 components', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    return store;
  }

  test("activeQuests is populated from quest.declared events at the window's reference time", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);

    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q1",
      plan: ["walk order", "docs"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T14:05:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(window.activeQuests).toEqual([
      {
        alias: "Q1",
        title: "Ship marko-ui",
        outcome: "86 components",
        plan: ["walk order", "docs"],
      },
    ]);
    expect(window.activeQuestAliases).toEqual({ Q1: "Q1" });
    expect(window.parentActiveQuests).toEqual([]);
    expect(window.parentActiveQuestAliases).toEqual({});
  });

  test("several declarations become activeQuests with Q aliases and a reverse map", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
         VALUES ('Q2', 'hero', 'H1', 'Fix the flake', 'green suite', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
      )
      .run();

    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q1",
      plan: ["walk order"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T14:05:00.000Z",
      heroId: "H1",
    });
    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q2",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T14:10:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(window.activeQuests.map((quest) => quest.alias)).toEqual(["Q1", "Q2"]);
    expect(window.activeQuests.map((quest) => quest.title)).toEqual([
      "Ship marko-ui",
      "Fix the flake",
    ]);
    expect(window.activeQuestAliases).toEqual({ Q1: "Q1", Q2: "Q2" });
  });

  test("planAliases indexes each active quest's plan under its own quest number", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
         VALUES ('Q2', 'hero', 'H1', 'Fix the flake', 'green suite', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
      )
      .run();

    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q1",
      plan: ["walk order", "docs"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T14:05:00.000Z",
      heroId: "H1",
    });
    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q2",
      plan: ["quarantine it"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T14:10:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(window.planAliases).toEqual({
      "P1.1": "walk order",
      "P1.2": "docs",
      "P2.1": "quarantine it",
    });
  });

  test("a subagent's planAliases keep the parent's plan items under PP aliases", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
         VALUES ('Q2', 'hero', 'H1', 'Verify the walk order fix', 'prove it holds', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_sessions
          (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
           started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('parent', '/c', 'p', '/c/p/parent.jsonl', '/w/marko-ui', 'personal', 'marko-ui', 'parent', 'main',
                 '2026-09-04T13:00:00.000Z', '2026-09-04T16:00:00.000Z', 1, 0, '[]', 'host', '2026-09-04T16:00:00.000Z')`,
      )
      .run();

    declareQuest(store, database, {
      sessionId: "parent",
      questId: "Q1",
      plan: ["walk order"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T13:05:00.000Z",
      heroId: "H1",
    });
    declareQuest(store, database, {
      sessionId: "s1",
      parentSessionId: "parent",
      questId: "Q2",
      plan: ["run the suite"],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-04T14:05:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    // The two alias spaces must not collide: both would otherwise be "P1.1".
    expect(window.planAliases).toEqual({ "P1.1": "run the suite", "PP1.1": "walk order" });
  });

  test("a quest declared done is no longer active for the window", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);

    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q1",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T14:05:00.000Z",
      heroId: "H1",
    });
    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q1",
      done: true,
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T14:20:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(window.activeQuests).toEqual([]);
  });

  test("a declaration whose --since starts after the window's end is not visible to it", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);

    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q1",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-05T09:00:00.000Z",
      since: "2026-09-05T08:00:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(window.activeQuests).toEqual([]);
    expect(window.activeQuestAliases).toEqual({});
  });

  test("a window before the first declaration, inside its coverage, is a declared window with the quest, its alias and its plan", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);

    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q1",
      plan: ["walk order", "docs"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-05T09:00:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      mode: "declared",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(window.mode).toBe("declared");
    expect(window.activeQuests.map((quest) => quest.alias)).toEqual(["Q1"]);
    expect(window.activeQuestAliases).toEqual({ Q1: "Q1" });
    expect(window.planAliases).toEqual({ "P1.1": "walk order", "P1.2": "docs" });
  });

  test("a window that ends before the session's own start is not covered", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);

    declareQuest(store, database, {
      sessionId: "s1",
      questId: "Q1",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-05T09:00:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      mode: "declared",
      sinceTs: null,
      ...memoryInput,
      windowEnd: "2026-09-04T13:55:00.000Z",
    });

    expect(window.activeQuests).toEqual([]);
  });

  test("a subagent's window carries its own quest and the parent's", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    const store = seedHeroAndQuest(database);
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at)
         VALUES ('Q2', 'hero', 'H1', 'Verify the walk order fix', 'prove it holds', 1, 1, 'started', '2026-09-01T00:00:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_sessions
          (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
           started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('parent', '/c', 'p', '/c/p/parent.jsonl', '/w/marko-ui', 'personal', 'marko-ui', 'parent', 'main',
                 '2026-09-04T13:00:00.000Z', '2026-09-04T16:00:00.000Z', 1, 0, '[]', 'host', '2026-09-04T16:00:00.000Z')`,
      )
      .run();

    declareQuest(store, database, {
      sessionId: "parent",
      questId: "Q1",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T13:05:00.000Z",
      heroId: "H1",
    });
    declareQuest(store, database, {
      sessionId: "s1",
      parentSessionId: "parent",
      questId: "Q2",
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-04T14:05:00.000Z",
      heroId: "H1",
    });

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
      windowEnd: "2026-09-04T15:20:00.000Z",
    });

    expect(window.activeQuests.map((quest) => quest.title)).toEqual(["Verify the walk order fix"]);
    expect(window.activeQuests[0]?.alias).toBe("Q1");
    expect(window.parentActiveQuests.map((quest) => quest.title)).toEqual(["Ship marko-ui"]);
    expect(window.parentActiveQuests[0]?.alias).toBe("PQ1");
    expect(window.parentActiveQuestAliases).toEqual({ PQ1: "Q1" });
  });

  test("aliases number both slices in list order and never leak a real id", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    seedEarlierSession(database);

    const window = buildWindow(database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:30:00.000Z",
      ...memoryInput,
    });

    // Session stints first, then recent: S1 is the open one, S2 the closed one.
    expect(window.sessionOpenStints.map((stint) => stint.stintId)).toEqual(["S1"]);
    expect(window.recentStints.map((stint) => stint.stintId)).toEqual(["S2"]);
    expect(window.openStintAliases).toEqual({ S1: "A1", S2: "A0" });
    expect(Object.keys(window.openStintAliases).every((alias) => /^S\d+$/.test(alias))).toBe(true);
  });
});

describe("window slice as of the window's end", () => {
  const windowEnd = "2026-09-04T15:20:00.000Z";
  const base = { sessionId: "s1", sinceTs: null, mode: "inferred" as const, ...memoryInput };

  function insertTrace(
    database: ReturnType<typeof openDatabase>,
    input: {
      id: string;
      stint: string;
      session: string;
      startedAt: string;
      endedAt?: string;
      what: string;
    },
  ) {
    database
      .query(
        `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
         VALUES (?, ?, 'claude-code', 'personal/marko-ui', 'session', ?, ?, 'hero', ?, 'ship', 'personal/marko-ui', 'claude-code', 0.9, 'assistant', ?, ?)`,
      )
      .run(
        input.id,
        input.stint,
        input.startedAt,
        input.endedAt ?? input.startedAt,
        input.what,
        input.session,
        input.startedAt,
      );
  }

  test("a stint that closed after the window ended was open at the window and is offered as open", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    // Later windows were already classified: A1 has since closed, at 16:00.
    database
      .query(
        "UPDATE stints SET closed_at = '2026-09-04T16:00:00.000Z', close_reason = 'idle' WHERE id = 'A1'",
      )
      .run();

    const window = buildWindow(database, { ...base, windowEnd });

    expect(window.sessionOpenStints.map((stint) => stint.stintId)).toEqual(["A1"]);
    expect(window.recentStints.map((stint) => stint.stintId)).toEqual([]);
  });

  test("a stint that closed before the window ended is still offered as closed", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    database
      .query(
        "UPDATE stints SET closed_at = '2026-09-04T15:00:00.000Z', close_reason = 'idle' WHERE id = 'A1'",
      )
      .run();

    const window = buildWindow(database, { ...base, windowEnd });

    expect(window.sessionOpenStints).toEqual([]);
    expect(window.recentStints.map((stint) => stint.stintId)).toEqual(["A1"]);
  });

  test("another session's stint that closed after the window is shown as still open", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedEarlierSession(database);
    database
      .query(
        "UPDATE stints SET closed_at = '2026-09-04T17:00:00.000Z', close_reason = 'session_end' WHERE id = 'A0'",
      )
      .run();

    const window = buildWindow(database, { ...base, windowEnd, memoryHours: 240 });

    expect(window.recentStints.map((stint) => [stint.stintId, stint.closedAt])).toEqual([
      ["A0", null],
    ]);
  });

  test("a trace that started after the window ended neither names the stint nor moves it to another session", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database);
    seedOpenStint(database);
    insertTrace(database, {
      id: "T-later",
      stint: "A1",
      session: "s-other",
      startedAt: "2026-09-04T15:50:00.000Z",
      what: "work from the window's future",
    });

    const window = buildWindow(database, { ...base, windowEnd });

    expect(window.sessionOpenStints.map((stint) => [stint.stintId, stint.what])).toEqual([
      ["A1", "fixing walk order"],
    ]);
  });

  describe("two traces ending in the same instant", () => {
    const latestWhat = (
      traces: { id: string; startedAt: string; what: string }[],
    ): string | undefined => {
      const database = openDatabase(":memory:");
      ensureTables(database);
      seedSession(database);
      seedOpenStint(database);
      // T1 (seeded) ends 14:30; the others all end together at 15:00.
      for (const trace of traces) {
        insertTrace(database, {
          ...trace,
          stint: "A1",
          session: "s1",
          endedAt: "2026-09-04T15:00:00.000Z",
        });
      }
      return buildWindow(database, { ...base, windowEnd }).sessionOpenStints[0]?.what;
    };

    test("the one that started later names the stint, whatever the ids", () => {
      // The later-started trace has the LOWER id, so neither id order explains the pick.
      expect(
        latestWhat([
          { id: "T-b", startedAt: "2026-09-04T14:40:00.000Z", what: "started earlier" },
          { id: "T-a", startedAt: "2026-09-04T14:50:00.000Z", what: "started later" },
        ]),
      ).toBe("started later");
      expect(
        latestWhat([
          { id: "T-a", startedAt: "2026-09-04T14:40:00.000Z", what: "started earlier" },
          { id: "T-b", startedAt: "2026-09-04T14:50:00.000Z", what: "started later" },
        ]),
      ).toBe("started later");
    });

    test("with the same start too, the higher id names the stint, in either insert order", () => {
      const tied = [
        { id: "T-a", startedAt: "2026-09-04T14:50:00.000Z", what: "lower id" },
        { id: "T-b", startedAt: "2026-09-04T14:50:00.000Z", what: "higher id" },
      ];
      expect(latestWhat(tied)).toBe("higher id");
      expect(latestWhat([...tied].reverse())).toBe("higher id");
    });
  });

  describe("open quests", () => {
    function insertQuest(
      database: ReturnType<typeof openDatabase>,
      id: string,
      columns: {
        state?: string;
        createdAt?: string;
        mergedInto?: string;
        retractedAt?: string;
      } = {},
    ) {
      database
        .query(
          `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, merged_into, retracted_at, created_at)
           VALUES (?, 'hero', 'H1', ?, 'o', 1, 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          id,
          columns.state ?? "started",
          columns.mergedInto ?? null,
          columns.retractedAt ?? null,
          columns.createdAt ?? "2026-09-01T00:00:00.000Z",
        );
    }

    function lifecycle(store: EventStore, quest: string, state: string, at: string) {
      store.append({
        actor: "hero",
        kind: "quest.lifecycle",
        subject: quest,
        at,
        payload: { state },
      });
    }

    const openIds = (database: ReturnType<typeof openDatabase>) =>
      (buildWindow(database, { ...base, windowEnd }).openQuests ?? []).map((quest) => quest.id);

    test("a quest created after the window ended is not offered", () => {
      const database = openDatabase(":memory:");
      ensureTables(database);
      seedSession(database);
      insertQuest(database, "Q-before");
      insertQuest(database, "Q-future", { createdAt: "2026-09-06T00:00:00.000Z" });

      expect(openIds(database)).toEqual(["Q-before"]);
    });

    test("a quest created at run time but already used by a stint before the window is offered", () => {
      const database = openDatabase(":memory:");
      ensureTables(database);
      seedSession(database);
      // Backfill stamps an inferred quest with the run's clock, not the segment's.
      insertQuest(database, "Q-inferred", { createdAt: "2026-10-18T08:55:44.678Z" });
      database
        .query(
          "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES ('A-used', 'Q-inferred', 'work', '2026-09-04T14:00:00.000Z', 1)",
        )
        .run();

      expect(openIds(database)).toEqual(["Q-inferred"]);
    });

    test("state is judged as of the window: later lifecycle events do not hide or revive a quest", () => {
      const database = openDatabase(":memory:");
      ensureTables(database);
      seedSession(database);
      const store = new EventStore(database);
      // Abandoned now, but only after the window: it was open then.
      insertQuest(database, "Q-abandoned-later", { state: "abandoned" });
      lifecycle(store, "Q-abandoned-later", "abandoned", "2026-09-04T16:00:00.000Z");
      // Started now, but paused before the window and resumed only after it.
      insertQuest(database, "Q-paused-then-resumed", { state: "resumed" });
      lifecycle(store, "Q-paused-then-resumed", "paused", "2026-09-04T14:00:00.000Z");
      lifecycle(store, "Q-paused-then-resumed", "resumed", "2026-09-04T16:00:00.000Z");
      // Abandoned before the window.
      insertQuest(database, "Q-abandoned-before", { state: "abandoned" });
      lifecycle(store, "Q-abandoned-before", "abandoned", "2026-09-04T14:00:00.000Z");

      expect(openIds(database)).toEqual(["Q-abandoned-later"]);
    });

    test("a merge or retraction after the window does not hide the quest, one before does", () => {
      const database = openDatabase(":memory:");
      ensureTables(database);
      seedSession(database);
      const store = new EventStore(database);
      insertQuest(database, "Q-target");
      insertQuest(database, "Q-merged-later", { mergedInto: "Q-target" });
      store.append({
        actor: "hero",
        kind: "quest.merged",
        subject: "Q-merged-later",
        at: "2026-09-04T16:00:00.000Z",
        payload: { into: "Q-target" },
      });
      insertQuest(database, "Q-merged-before", { mergedInto: "Q-target" });
      store.append({
        actor: "hero",
        kind: "quest.merged",
        subject: "Q-merged-before",
        at: "2026-09-04T14:00:00.000Z",
        payload: { into: "Q-target" },
      });
      insertQuest(database, "Q-retracted-later", { retractedAt: "2026-09-04T16:00:00.000Z" });
      insertQuest(database, "Q-retracted-before", { retractedAt: "2026-09-04T14:00:00.000Z" });

      expect(openIds(database).sort()).toEqual(["Q-merged-later", "Q-retracted-later", "Q-target"]);
    });

    test("the list is ranked session, then project, then the rest, each newest first, and capped", () => {
      const database = openDatabase(":memory:");
      ensureTables(database);
      seedSession(database);
      for (const id of ["Q-session-old", "Q-session-new", "Q-project", "Q-elsewhere", "Q-unused"]) {
        insertQuest(database, id);
      }
      // Closed and a day before the window, so no stint of theirs is offered: the cap alone
      // decides which quests are listed.
      const use = (quest: string, session: string, place: string, at: string) => {
        database
          .query(
            "INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, close_reason, revision) VALUES (?, ?, 'work', ?, ?, 'idle', 1)",
          )
          .run(`S-${quest}-${at}`, quest, at, at);
        database
          .query(
            `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
             VALUES (?, ?, 'claude-code', ?, 'session', ?, ?, 'hero', 'w', 'w', ?, 'claude-code', 0.9, 'assistant', ?, ?)`,
          )
          .run(`T-${quest}-${at}`, `S-${quest}-${at}`, place, at, at, place, session, at);
      };
      use("Q-session-old", "s1", "personal/marko-ui", "2026-09-03T10:00:00.000Z");
      use("Q-session-new", "s1", "personal/marko-ui", "2026-09-03T12:00:00.000Z");
      // Newer than both session quests, but another session's: ranks below them.
      use("Q-project", "s-other", "personal/marko-ui", "2026-09-03T15:00:00.000Z");
      use("Q-elsewhere", "s-other", "personal/other", "2026-09-03T15:10:00.000Z");

      const ids = (memoryQuests: number) =>
        (buildWindow(database, { ...base, windowEnd, memoryQuests }).openQuests ?? []).map(
          (quest) => quest.id,
        );

      expect(ids(10)).toEqual([
        "Q-session-new",
        "Q-session-old",
        "Q-project",
        "Q-elsewhere",
        "Q-unused",
      ]);
      expect(ids(3)).toEqual(["Q-session-new", "Q-session-old", "Q-project"]);
      expect(ids(1)).toEqual(["Q-session-new"]);
      expect(ids(0)).toEqual([]);
    });

    describe("the quests of the stints the window offers", () => {
      const addStint = (
        database: ReturnType<typeof openDatabase>,
        input: {
          stint: string;
          quest: string;
          session: string;
          at: string;
          closedAt?: string;
        },
      ) => {
        database
          .query(
            "INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, close_reason, revision) VALUES (?, ?, 'work', ?, ?, ?, 1)",
          )
          .run(
            input.stint,
            input.quest,
            input.at,
            input.closedAt ?? null,
            input.closedAt ? "idle" : null,
          );
        insertTrace(database, {
          id: `T-${input.stint}`,
          stint: input.stint,
          session: input.session,
          startedAt: input.at,
          what: "w",
        });
      };
      const ids = (database: ReturnType<typeof openDatabase>, memoryQuests: number) =>
        (buildWindow(database, { ...base, windowEnd, memoryQuests }).openQuests ?? []).map(
          (quest) => quest.id,
        );

      test("a session-open and a recent stint's quest is offered even when the cap would drop it", () => {
        const database = openDatabase(":memory:");
        ensureTables(database);
        seedSession(database);
        // Ten quests this session used more recently than the two below, a day back so
        // their stints are not offered and only the cap ranks them.
        for (let index = 0; index < 10; index += 1) {
          const id = `Q-hot-${String(index).padStart(2, "0")}`;
          insertQuest(database, id);
          addStint(database, {
            stint: `S-${id}`,
            quest: id,
            session: "s1",
            at: `2026-09-03T13:${String(10 + index)}:00.000Z`,
            closedAt: `2026-09-03T13:${String(10 + index)}:30.000Z`,
          });
        }
        // The session's own open stint, long idle: oldest use of all.
        insertQuest(database, "Q-open");
        addStint(database, {
          stint: "S-open",
          quest: "Q-open",
          session: "s1",
          at: "2026-09-04T08:00:00.000Z",
        });
        // Another session's recent stint in the same project: not this session's, not the newest.
        insertQuest(database, "Q-recent");
        addStint(database, {
          stint: "S-recent",
          quest: "Q-recent",
          session: "s-other",
          at: "2026-09-04T13:00:00.000Z",
          closedAt: "2026-09-04T13:05:00.000Z",
        });

        const window = buildWindow(database, { ...base, windowEnd, memoryQuests: 3 });
        expect(window.sessionOpenStints.map((stint) => stint.stintId)).toEqual(["S-open"]);
        expect(window.recentStints.map((stint) => stint.stintId)).toContain("S-recent");
        const offered = (window.openQuests ?? []).map((quest) => quest.id);
        expect(offered).toContain("Q-open");
        expect(offered).toContain("Q-recent");
        // The pinned two come first; the one remaining slot is the best-ranked of the rest.
        expect(offered).toHaveLength(3);
        expect(offered.slice(0, 2).sort()).toEqual(["Q-open", "Q-recent"]);
      });

      test("the pinned quests exceed the cap rather than lose one, and 0 offers only them", () => {
        const database = openDatabase(":memory:");
        ensureTables(database);
        seedSession(database);
        insertQuest(database, "Q-other");
        insertQuest(database, "Q-open");
        addStint(database, {
          stint: "S-open",
          quest: "Q-open",
          session: "s1",
          at: "2026-09-04T08:00:00.000Z",
        });

        expect(ids(database, 0)).toEqual(["Q-open"]);
        expect(ids(database, 1)).toEqual(["Q-open"]);
        expect(ids(database, 2)).toEqual(["Q-open", "Q-other"]);
      });

      test("a stint's quest that was abandoned before the window is still not offered", () => {
        const database = openDatabase(":memory:");
        ensureTables(database);
        seedSession(database);
        const store = new EventStore(database);
        insertQuest(database, "Q-gone", { state: "abandoned" });
        lifecycle(store, "Q-gone", "abandoned", "2026-09-04T14:00:00.000Z");
        addStint(database, {
          stint: "S-open",
          quest: "Q-gone",
          session: "s1",
          at: "2026-09-04T08:00:00.000Z",
        });

        expect(ids(database, 5)).toEqual([]);
      });
    });

    test("a retracted trace does not make a quest relevant to the session", () => {
      const database = openDatabase(":memory:");
      ensureTables(database);
      seedSession(database);
      seedOpenStint(database);
      insertQuest(database, "Q-other");
      database
        .query(
          "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES ('S-other', 'Q-other', 'w', '2026-09-04T09:00:00.000Z', 1)",
        )
        .run();
      insertTrace(database, {
        id: "T-retracted",
        stint: "S-other",
        session: "s1",
        startedAt: "2026-09-04T09:00:00.000Z",
        what: "w",
      });
      database
        .query(
          "UPDATE traces SET retracted_at = '2026-09-04T09:30:00.000Z' WHERE id = 'T-retracted'",
        )
        .run();

      const ids = (
        buildWindow(database, { ...base, windowEnd, memoryQuests: 1 }).openQuests ?? []
      ).map((quest) => quest.id);

      // Q1 is the seeded quest of this session's stint; Q-other only has a retracted trace.
      expect(ids).toEqual(["Q1"]);
    });

    test("lastStintAt ignores traces that started after the window", () => {
      const database = openDatabase(":memory:");
      ensureTables(database);
      seedSession(database);
      seedOpenStint(database);
      insertTrace(database, {
        id: "T-later",
        stint: "A1",
        session: "s1",
        startedAt: "2026-09-04T16:30:00.000Z",
        what: "later",
      });

      const quest = buildWindow(database, { ...base, windowEnd }).openQuests?.[0];

      expect(quest?.lastStintAt).toBe("2026-09-04T14:00:00.000Z");
    });
  });
});
