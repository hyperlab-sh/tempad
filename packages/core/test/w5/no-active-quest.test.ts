import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { declareQuest } from "../../src/intent/declarations";
import { ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { applyResult } from "../../src/w5/apply";
import { validateResult } from "../../src/w5/classifier";
import { buildWindow } from "../../src/w5/window";

registerAllProjections();

/**
 * The live failure: `classifier result invalid: segments[0].quest: expected an
 * active quest alias when belongs is true`, on windows of a session with no
 * active quest. These drive the real chain (`buildWindow` -> `validateResult` ->
 * `applyResult`) for each way a session ends up there, with the answer the model
 * gave: `belongs: true` and no quest to name.
 */

const WINDOW_END = "2026-09-04T15:20:00.000Z";

function seed() {
  const database = openDatabase(":memory:");
  ensureTables(database);
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/marko-ui', 'personal', 'marko-ui', 'marko-ui', 'main',
               '2026-09-04T14:00:00.000Z', '${WINDOW_END}', 2, 0, '[]', 'host', '${WINDOW_END}')`,
    )
    .run();
  const insertMessage = database.query(
    `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
     VALUES (?, 's1', ?, 'user', 0, ?)`,
  );
  insertMessage.run("m1", "2026-09-04T15:00:00.000Z", "fix the walk order bug");
  insertMessage.run("m2", WINDOW_END, "now the docs");
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
  return { database, store: new EventStore(database) };
}

function declareFor(
  { database, store }: ReturnType<typeof seed>,
  at: string,
  extra: { done?: boolean } = {},
) {
  declareQuest(store, database, {
    sessionId: "s1",
    questId: "Q1",
    plan: ["walk order"],
    scope: "session",
    declaredBy: "agent",
    at,
    heroId: "H1",
    ...extra,
  });
}

/** The model's answer for a window it was told has no active quest. */
function modelAnswer(quest: string | null | undefined) {
  return {
    segments: [
      {
        startedAt: "2026-09-04T15:00:00.000Z",
        endedAt: WINDOW_END,
        what: "fix walk order",
        why: "unknown",
        belongs: true,
        guess: null,
        ...(quest === undefined ? {} : { quest }),
        stint: "new: fixing the walk order",
        isSwitch: false,
        trigger: null,
        confidence: 0.8,
      },
    ],
    sessionNote: null,
  };
}

function classifyAndApply({ database, store }: ReturnType<typeof seed>, quest?: string | null) {
  const window = buildWindow(database, {
    sessionId: "s1",
    sinceTs: null,
    maxMessages: 50,
    memoryHours: 8,
    memoryStints: 10,
    memoryQuests: 20,
    overlapMessages: 3,
    windowEnd: WINDOW_END,
  });
  expect(window.activeQuests).toEqual([]);
  expect(window.parentActiveQuests).toEqual([]);

  const result = validateResult(modelAnswer(quest), window);
  const summary = applyResult(store, database, window, result, {
    actor: "hook",
    askingEnabled: true,
    now: "2026-09-04T15:30:00.000Z",
    log: () => {},
    mode: "declared",
    stintMinMinutes: 5,
  });
  return { result, summary };
}

function expectRecordedWithoutQuestAndOneDeclareQuestion({
  database,
}: ReturnType<typeof seed>): void {
  const stints = database.query("SELECT quest_id as questId FROM stints").all() as {
    questId: string | null;
  }[];
  expect(stints).toHaveLength(1);
  expect(stints[0]?.questId).toBeNull();

  // The window's work is recorded and is not a doubt; the gap is one question.
  const traces = database.query("SELECT doubt FROM traces").all() as { doubt: string | null }[];
  expect(traces).toHaveLength(1);
  expect(traces[0]?.doubt).toBeNull();
  const questions = database.query("SELECT kind FROM questions").all() as { kind: string }[];
  expect(questions).toEqual([{ kind: "declare" }]);
}

describe("a window with no active quest and a model that says belongs: true", () => {
  // Every other way a session reaches zero active quests is covered by
  // "declared" cases below; this is the one with nothing declared at all.
  test("cause A: the session never declared anything", () => {
    const fixture = seed();

    const { result, summary } = classifyAndApply(fixture, null);

    expect(result.selectorDefaulted).toBe(1);
    expect(summary.traces).toBe(1);
    expect(summary.doubts).toBe(0);
    expectRecordedWithoutQuestAndOneDeclareQuestion(fixture);
  });

  test("cause B: the quest was declared only after the window", () => {
    const fixture = seed();
    declareFor(fixture, "2026-09-04T16:00:00.000Z");

    const { result, summary } = classifyAndApply(fixture, "Q1");

    // `Q1` is an alias this window never offered, because at the window's own
    // time nothing was declared yet.
    expect(result.selectorDefaulted).toBe(1);
    expect(summary.doubts).toBe(0);
    expectRecordedWithoutQuestAndOneDeclareQuestion(fixture);
  });

  test("cause C: the only declared quest was ended with --done before the window", () => {
    const fixture = seed();
    declareFor(fixture, "2026-09-04T14:05:00.000Z");
    declareFor(fixture, "2026-09-04T14:30:00.000Z", { done: true });

    const { result, summary } = classifyAndApply(fixture, undefined);

    expect(result.selectorDefaulted).toBe(1);
    expect(summary.doubts).toBe(0);
    expectRecordedWithoutQuestAndOneDeclareQuestion(fixture);
  });

  test("cause D: the only declared quest was retracted", () => {
    const fixture = seed();
    declareFor(fixture, "2026-09-04T14:05:00.000Z");
    fixture.database
      .query("UPDATE quests SET retracted_at = '2026-09-04T14:40:00.000Z' WHERE id = 'Q1'")
      .run();

    const { result, summary } = classifyAndApply(fixture, "Q1");

    expect(result.selectorDefaulted).toBe(1);
    expect(summary.doubts).toBe(0);
    expectRecordedWithoutQuestAndOneDeclareQuestion(fixture);
  });

  test("a quest that is active still gets its alias checked: one declared quest is assigned silently", () => {
    const fixture = seed();
    declareFor(fixture, "2026-09-04T14:05:00.000Z");
    const window = buildWindow(fixture.database, {
      sessionId: "s1",
      sinceTs: null,
      maxMessages: 50,
      memoryHours: 8,
      memoryStints: 10,
      memoryQuests: 20,
      overlapMessages: 3,
      windowEnd: WINDOW_END,
    });

    const result = validateResult(modelAnswer(null), window);

    expect(result.segments[0]?.quest).toBe("Q1");
    expect(result.segments[0]?.belongs).toBe(true);
    expect(result.selectorDefaulted).toBe(0);
  });
});

describe("a window whose answer lies in the overlap tail", () => {
  test("validateResult drops the segment, so applying records no trace and asks no declare question", () => {
    const fixture = seed();
    // A tail message before the window: the window starts at the next message.
    fixture.database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m0', 's1', '2026-09-04T14:50:00.000Z', 'user', 0, 'earlier work')`,
      )
      .run();
    const window = buildWindow(fixture.database, {
      sessionId: "s1",
      sinceTs: "2026-09-04T14:50:00.000Z",
      maxMessages: 50,
      memoryHours: 8,
      memoryStints: 10,
      memoryQuests: 20,
      overlapMessages: 3,
      windowEnd: WINDOW_END,
    });
    expect(window.overlapMessages.length).toBeGreaterThan(0);
    const answer = modelAnswer(null);
    answer.segments[0] = {
      ...answer.segments[0],
      startedAt: "2026-09-04T14:40:00.000Z",
      endedAt: "2026-09-04T14:50:00.000Z",
    } as (typeof answer.segments)[number];

    const result = validateResult(answer, window);
    const summary = applyResult(fixture.store, fixture.database, window, result, {
      actor: "hook",
      askingEnabled: true,
      now: "2026-09-04T15:30:00.000Z",
      log: () => {},
      mode: "declared",
      stintMinMinutes: 5,
    });

    expect(result.overlapDropped).toBe(1);
    expect(summary.traces).toBe(0);
    expect(fixture.database.query("SELECT 1 FROM traces").all()).toHaveLength(0);
    expect(fixture.database.query("SELECT 1 FROM questions").all()).toHaveLength(0);
  });
});
