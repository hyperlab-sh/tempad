import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { messageAuthorship } from "../../src/w5/authorship";
import { validateResult } from "../../src/w5/classifier";
import { buildSystemPrompt, buildUserPrompt } from "../../src/w5/prompt";
import { buildWindow } from "../../src/w5/window";

registerAllProjections();

/** The declared system prompt must keep every variant inside the shared budget. */
test("declared prompt variants stay within the byte budget", () => {
  for (const variant of [undefined, { sessionKind: null }, { sessionKind: "lead" as const }]) {
    const bytes = Buffer.byteLength(buildSystemPrompt("declared", variant), "utf8");
    expect(bytes).toBeLessThanOrEqual(2560);
    expect(bytes).toBeGreaterThan(1500);
  }
});

test("lead variant adds the coordination paragraph, other kinds do not", () => {
  const plain = buildSystemPrompt("declared", { sessionKind: "human" });
  const lead = buildSystemPrompt("declared", { sessionKind: "lead" });
  expect(lead).toContain("coordinates other agents");
  expect(plain).not.toContain("coordinates other agents");
  // The paragraph is appended, so the lead prompt is strictly longer.
  expect(lead.length).toBeGreaterThan(plain.length);
});

test("declared prompt carries the maneuver list and human-trigger rules", () => {
  const prompt = buildSystemPrompt("declared");
  expect(prompt).toContain("Never a deviation");
  expect(prompt).toContain("tests/waiting, rebase/merge, code review");
  expect(prompt).toContain("quotes the human message");
  expect(prompt).toContain("No human trigger");
  expect(prompt).toContain("never deviate");
  expect(prompt).toContain('"proposedQuest": {"title": string} | null');
});

test("inferred prompt is unchanged by the session-kind variant", () => {
  expect(buildSystemPrompt("inferred", { sessionKind: "lead" })).toBe(
    buildSystemPrompt("inferred"),
  );
});

describe("messageAuthorship", () => {
  test("classifies by role, origin and markers", () => {
    const cases: [Parameters<typeof messageAuthorship>[0], ReturnType<typeof messageAuthorship>][] =
      [
        [{ role: "assistant", text: "looking at it" }, "agent"],
        [{ role: "system", text: "init" }, "tool"],
        [{ role: "user", originKind: "human", text: "fix the bug" }, "human"],
        [{ role: "user", originKind: "peer", text: "delegate this" }, "agent"],
        [{ role: "user", text: "<system-reminder>check hooks</system-reminder>" }, "tool"],
        [{ role: "user", text: "[SYSTEM NOTIFICATION] x" }, "tool"],
        [{ role: "user", text: "<task-notification>done</task-notification>" }, "tool"],
        [{ role: "user", text: "You are a helpful subagent" }, "agent"],
        [{ role: "user", text: "please continue" }, "human"],
        [{ role: "user", text: "" }, "human"],
        [{ role: "user", originKind: "human", text: "<system-reminder>x" }, "human"],
        [{ role: "unknown-role", text: "?" }, "agent"],
      ];
    for (const [input, expected] of cases) {
      expect(messageAuthorship(input)).toBe(expected);
    }
  });
});

const baseWindow = {
  sessionId: "s1",
  title: "t",
  cwd: "/w",
  gitBranch: "main",
  org: "personal",
  project: "p",
  mode: "declared" as const,
  sessionKind: "human" as const,
  activeQuests: [],
  activeQuestAliases: {},
  parentActiveQuests: [],
  parentActiveQuestAliases: {},
  openStintAliases: {},
  planAliases: {},
  sessionOpenStints: [],
  recentStints: [],
  overlapMessages: [],
  previousSessionNote: null,
  messages: [],
};

test("user prompt labels message authorship and the session kind", () => {
  const prompt = buildUserPrompt({
    ...baseWindow,
    messages: [
      { ts: "2026-09-04T15:00:00.000Z", role: "user", text: "fix it", authorship: "human" },
      { ts: "2026-09-04T15:05:00.000Z", role: "assistant", text: "on it", authorship: "agent" },
      { ts: "2026-09-04T15:06:00.000Z", role: "user", text: "[SYSTEM NOTIFICATION] x" },
    ],
    overlapMessages: [
      { ts: "2026-09-04T14:50:00.000Z", role: "user", text: "earlier", authorship: "human" },
    ],
  });
  expect(prompt).toContain("session kind: human");
  expect(prompt).toContain("user/human: fix it");
  expect(prompt).toContain("assistant/agent: on it");
  // A hand-built message with no authorship label still gets one at render time.
  expect(prompt).toContain("user/tool: [SYSTEM NOTIFICATION] x");
  expect(prompt).toContain("user/human: earlier");
});

test("user prompt renders quest outcomes on stints and side quests", () => {
  const prompt = buildUserPrompt({
    ...baseWindow,
    mode: "declared",
    sessionOpenStints: [
      {
        stintId: "S1",
        what: "fixing walk order",
        why: "unknown",
        questId: "q1",
        questTitle: "walk order",
        questOutcome: "pages render in order",
        openedAt: "2026-09-04T10:00:00.000Z",
        lastTraceEndedAt: "2026-09-04T11:00:00.000Z",
      },
    ],
    recentStints: [
      {
        stintId: "S2",
        what: "docs",
        why: "unknown",
        questId: null,
        questTitle: null,
        questOutcome: null,
        openedAt: "2026-09-04T09:00:00.000Z",
        lastTraceEndedAt: "2026-09-04T09:30:00.000Z",
        closedAt: "2026-09-04T09:30:00.000Z",
        closeReason: "idle",
      },
    ],
  });
  expect(prompt).toContain("quest walk order — pages render in order");
  expect(prompt).toContain("quest none");

  const inferredPrompt = buildUserPrompt({
    ...baseWindow,
    mode: "inferred",
    openQuests: [],
    recentSideQuests: [
      { id: "q9", title: "investigate flake", outcome: "test suite is green", trigger: "why now?" },
      { id: "q8", title: "old thing", outcome: null, trigger: "huh" },
    ],
  });
  expect(inferredPrompt).toContain("investigate flake — test suite is green — triggered by");
  expect(inferredPrompt).toContain("old thing — no outcome — triggered by");
});

describe("declared-mode proposedQuest downgrade", () => {
  const window = { ...baseWindow, messages: [] };

  test("keeps a titled deviation with a trigger", () => {
    const result = validateResult(
      {
        segments: [
          {
            startedAt: "2026-09-04T15:00:00.000Z",
            endedAt: "2026-09-04T15:10:00.000Z",
            what: "x",
            why: "unknown",
            belongs: false,
            guess: "other work",
            quest: null,
            stint: "new: x",
            isSwitch: true,
            trigger: "actually let's do this instead",
            proposedQuest: { title: "other work" },
            confidence: 0.7,
          },
        ],
        sessionNote: null,
      },
      window,
    );
    expect(result.segments[0]?.proposedQuest).toEqual({ title: "other work" });
    expect(result.selectorDefaulted).toBe(0);
  });

  test("drops a proposal without a title, a trigger, or on a belonging segment", () => {
    const build = (overrides: Record<string, unknown>) => ({
      segments: [
        {
          startedAt: "2026-09-04T15:00:00.000Z",
          endedAt: "2026-09-04T15:10:00.000Z",
          what: "x",
          why: "unknown",
          belongs: false,
          guess: "other",
          quest: null,
          stint: "new: x",
          isSwitch: false,
          trigger: "a real quote",
          proposedQuest: { title: "titled" },
          confidence: 0.5,
          ...overrides,
        },
      ],
      sessionNote: null,
    });
    // missing title
    expect(
      validateResult(build({ proposedQuest: { title: "  " } }), window).segments[0]?.proposedQuest,
    ).toBeNull();
    // no trigger
    expect(validateResult(build({ trigger: null }), window).segments[0]?.proposedQuest).toBeNull();
    // belongs true: never a proposal
    expect(validateResult(build({ belongs: true }), window).segments[0]?.proposedQuest).toBeNull();
    // each downgrade counts once
    expect(validateResult(build({ trigger: null }), window).selectorDefaulted).toBe(1);
    // a non-object proposal is downgraded too, not a validation failure
    expect(
      validateResult(build({ proposedQuest: "nope" }), window).segments[0]?.proposedQuest,
    ).toBeNull();
  });
});

test("buildWindow fills sessionKind from the session_kind table and labels authorship", () => {
  const database = openDatabase(":memory:");
  ensureTables(database);
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w', 'personal', 'p', 't', 'main',
               '2026-09-04T14:00:00.000Z', '2026-09-04T15:00:00.000Z', 3, 0, '[]', 'host', '2026-09-04T15:00:00.000Z')`,
    )
    .run();
  const insertMessage = database.query(
    `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, origin_kind, text_preview)
     VALUES (?, 's1', ?, ?, 0, ?, ?)`,
  );
  insertMessage.run("m1", "2026-09-04T14:00:00.000Z", "user", "human", "fix the bug");
  insertMessage.run("m2", "2026-09-04T14:10:00.000Z", "user", null, "<system-reminder>x");
  insertMessage.run("m3", "2026-09-04T14:20:00.000Z", "assistant", null, "on it");
  database
    .query(
      `INSERT INTO session_kind (session_id, origin, kind, source, confidence, classifier_version, set_at, event_uid)
       VALUES ('s1', 'manual', 'lead', 'test', 1, 1, '2026-09-04T14:00:00.000Z', NULL)`,
    )
    .run();

  const window = buildWindow(database, {
    sessionId: "s1",
    sinceTs: null,
    maxMessages: 50,
    memoryHours: 8,
    memoryStints: 10,
    memoryQuests: 20,
    overlapMessages: 3,
    mode: "declared",
  });
  expect(window.sessionKind).toBe("lead");
  expect(window.messages.map((message) => message.authorship)).toEqual(["human", "tool", "agent"]);
  const prompt = buildUserPrompt(window);
  expect(prompt).toContain("user/human: fix the bug");
  expect(prompt).toContain("user/tool: <system-reminder>x");
  expect(prompt).toContain("assistant/agent: on it");
});

test("an explicit sessionKind input wins over the table", () => {
  const database = openDatabase(":memory:");
  ensureTables(database);
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w', 'personal', 'p', 't', 'main',
               '2026-09-04T14:00:00.000Z', '2026-09-04T15:00:00.000Z', 1, 0, '[]', 'host', '2026-09-04T15:00:00.000Z')`,
    )
    .run();
  database
    .query(
      `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
       VALUES ('m1', 's1', '2026-09-04T14:00:00.000Z', 'user', 0, 'hi')`,
    )
    .run();
  const window = buildWindow(database, {
    sessionId: "s1",
    sinceTs: null,
    maxMessages: 50,
    memoryHours: 8,
    memoryStints: 10,
    memoryQuests: 20,
    overlapMessages: 3,
    mode: "declared",
    sessionKind: "subagent",
  });
  expect(window.sessionKind).toBe("subagent");
});

test("a session with no kind row resolves to null", () => {
  const database = openDatabase(":memory:");
  ensureTables(database);
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w', 'personal', 'p', 't', 'main',
               '2026-09-04T14:00:00.000Z', '2026-09-04T15:00:00.000Z', 1, 0, '[]', 'host', '2026-09-04T15:00:00.000Z')`,
    )
    .run();
  database
    .query(
      `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
       VALUES ('m1', 's1', '2026-09-04T14:00:00.000Z', 'user', 0, 'hi')`,
    )
    .run();
  const window = buildWindow(database, {
    sessionId: "s1",
    sinceTs: null,
    maxMessages: 50,
    memoryHours: 8,
    memoryStints: 10,
    memoryQuests: 20,
    overlapMessages: 3,
    mode: "declared",
  });
  expect(window.sessionKind).toBeNull();
});
