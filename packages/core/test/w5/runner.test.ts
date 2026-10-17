import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import type { W5Config } from "../../src/intent/config";
import { declareQuest } from "../../src/intent/declarations";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import type { Classifier, ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";
import {
  ClassifierResponseError,
  RESPONSE_EXCERPT_LENGTH,
  RESPONSE_EXCERPT_MARKER,
} from "../../src/w5/classifier-shared";
import { buildBelongsHandback } from "../../src/w5/hooks";
import { claimNextJob, enqueueJob, JOB_LEASE_MINUTES, JOB_MAX_ATTEMPTS } from "../../src/w5/jobs";
import { runOnce } from "../../src/w5/runner";

registerAllProjections();

function makeConfig(claudeDir: string): Config {
  return {
    mondayApiToken: "t",
    mondayUser: "u",
    ghUser: "u",
    ghOrgs: [],
    ghIncludePersonal: false,
    ghToken: undefined,
    gitAuthorEmails: [],
    claudeDirs: [claudeDir],
    hostSlug: "host",
    tz: "UTC",
    since: "2020-01-01",
    syncToken: "unused",
    home: claudeDir,
  };
}

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

const good: ClassifierResult = {
  segments: [
    {
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:20:00.000Z",
      what: "fix walk order",
      why: "ship marko-ui",
      belongs: true,
      guess: null,
      matchedQuest: null,
      proposedQuest: null,
      matchedStint: null,
      continuesStint: null,
      newStintReason: "first work of the session",
      isSwitch: false,
      trigger: null,
      confidence: 0.9,
      questions: [],
    },
  ],
  sessionNote: null,
};

class FakeClassifier implements Classifier {
  constructor(private readonly result: ClassifierResult | (() => Promise<ClassifierResult>)) {}
  async classify(_window: ClassifierWindow): Promise<ClassifierResult> {
    if (typeof this.result === "function") return this.result();
    return this.result;
  }
}

function seedSessionWithMessages(
  database: ReturnType<typeof openDatabase>,
  filePath: string,
): void {
  const lines = [
    JSON.stringify({
      type: "user",
      uuid: "m1",
      sessionId: "s1",
      timestamp: "2026-09-04T15:00:00.000Z",
      cwd: "/w/marko-ui",
      gitBranch: "main",
      message: { role: "user", content: "fix walk order" },
    }),
    JSON.stringify({
      type: "user",
      uuid: "m2",
      sessionId: "s1",
      timestamp: "2026-09-04T15:20:00.000Z",
      cwd: "/w/marko-ui",
      gitBranch: "main",
      message: { role: "user", content: "done" },
    }),
  ];
  writeFileSync(filePath, `${lines.join("\n")}\n`);

  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', ?, 'p', ?, '/w/marko-ui', 'personal', 'marko-ui', 'marko-ui', 'main',
               '2026-09-04T15:00:00.000Z', '2026-09-04T15:20:00.000Z', 2, 0, '[]', 'host', '2026-09-04T15:20:00.000Z')`,
    )
    .run(filePath.slice(0, filePath.lastIndexOf("/")), filePath);
  database
    .query(
      "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES ('m1', 's1', '2026-09-04T15:00:00.000Z', 'user', 0, 'fix walk order')",
    )
    .run();
  database
    .query(
      "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES ('m2', 's1', '2026-09-04T15:20:00.000Z', 'user', 0, 'done')",
    )
    .run();
}

const THREE_WINDOW_MESSAGES = [
  ["w1a", "2026-09-04T15:00:00.000Z", "fix walk order"],
  ["w1b", "2026-09-04T15:10:00.000Z", "still on walk order"],
  ["w2a", "2026-09-04T15:20:00.000Z", "same bug, new idea"],
  ["w2b", "2026-09-04T15:30:00.000Z", "almost there"],
  // Two hours later: past activityIdleMinutes, so the stint closes as idle.
  ["w3a", "2026-09-04T17:30:00.000Z", "back to the walk order bug"],
  ["w3b", "2026-09-04T17:40:00.000Z", "fixed it"],
] as const;

/**
 * One session whose messages arrive across three runs: two back to back, then a
 * long idle gap before the third. `count` is how many messages exist so far, so
 * each run sees only the transcript written before it, as a live session does.
 */
function seedThreeWindowSession(
  database: ReturnType<typeof openDatabase>,
  filePath: string,
  count: number,
): void {
  const timestamps = THREE_WINDOW_MESSAGES.slice(0, count);

  writeFileSync(
    filePath,
    `${timestamps
      .map(([uuid, ts, text]) =>
        JSON.stringify({
          type: "user",
          uuid,
          sessionId: "s1",
          timestamp: ts,
          cwd: "/w/marko-ui",
          gitBranch: "main",
          message: { role: "user", content: text },
        }),
      )
      .join("\n")}\n`,
  );

  const lastTs = timestamps.at(-1)?.[1] ?? "2026-09-04T15:00:00.000Z";
  database
    .query(
      `INSERT OR REPLACE INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', ?, 'p', ?, '/w/marko-ui', 'personal', 'marko-ui', 'marko-ui', 'main',
               '2026-09-04T15:00:00.000Z', ?, ?, 0, '[]', 'host', ?)`,
    )
    .run(filePath.slice(0, filePath.lastIndexOf("/")), filePath, lastTs, timestamps.length, lastTs);

  const insert = database.query(
    "INSERT OR REPLACE INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES (?, 's1', ?, 'user', 0, ?)",
  );
  for (const [uuid, ts, text] of timestamps) insert.run(uuid, ts, text);
}

function seedHero(database: ReturnType<typeof openDatabase>) {
  ensureTables(database);
  const store = new EventStore(database);
  applyIncremental(
    database,
    store.append({
      actor: "hero",
      kind: "hero.created",
      subject: "H1",
      payload: { name: "Saulo" },
    }),
  );
}

describe("runOnce", () => {
  test("claims a job, classifies, applies, completes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      const classifier = new FakeClassifier(good);
      const logs: string[] = [];
      const result = await runOnce(database, makeConfig(dir), config, classifier, {
        now: "2026-09-04T15:21:00.000Z",
        log: (line) => logs.push(line),
      });

      expect(result.ran).toBe(true);
      expect(result.sessionId).toBe("s1");
      expect(result.summary?.traces).toBe(1);

      const job = database.query("SELECT state FROM w5_jobs").get() as { state: string };
      expect(job.state).toBe("done");

      const run = database.query("SELECT session_id FROM w5_runs").get() as { session_id: string };
      expect(run.session_id).toBe("s1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns ran: false when there is no job", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    const classifier = new FakeClassifier(good);
    const result = await runOnce(database, makeConfig("/tmp"), config, classifier, {
      log: () => {},
    });
    expect(result.ran).toBe(false);
  });

  test("computes sessionActivityMinutes from claude_messages instead of hardcoding 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: false, throttleMinutes: 10 });

      const withQuestion: ClassifierResult = {
        segments: [
          {
            startedAt: "2026-09-04T15:00:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            what: "fix walk order",
            why: "unknown",
            belongs: true,
            guess: null,
            matchedQuest: null,
            proposedQuest: null,
            matchedStint: null,
            continuesStint: null,
            newStintReason: "first work of the window",
            isSwitch: false,
            trigger: null,
            confidence: 0.6,
            questions: ["why"],
          },
        ],
        sessionNote: null,
      };
      const classifier = new FakeClassifier(withQuestion);
      const lowWatchConfig: W5Config = { ...config, watchTurns: 2, askMinStintMinutes: 20 };

      await runOnce(database, makeConfig(dir), lowWatchConfig, classifier, {
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
      });

      // session spans exactly 20 minutes (15:00 -> 15:20), meeting askMinActivityMinutes;
      // with sessionActivityMinutes hardcoded to 0 this question would never qualify to be asked.
      const question = database.query("SELECT state FROM questions").get() as { state: string };
      expect(question.state).toBe("asked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a classifier that throws marks the job failed and does not throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      const classifier = new FakeClassifier(async () => {
        throw new Error("boom");
      });
      const logs: string[] = [];
      const result = await runOnce(database, makeConfig(dir), config, classifier, {
        now: "2026-09-04T15:21:00.000Z",
        log: (line) => logs.push(line),
      });

      expect(result.ran).toBe(true);
      const job = database.query("SELECT state, error FROM w5_jobs").get() as {
        state: string;
        error: string;
      };
      expect(job.state).toBe("failed");
      expect(job.error).toContain("boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rejected response is kept, bounded, after the error message on the failed job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      const rawResponse = `{"segments": [${"x".repeat(2000)}`;
      const classifier = new FakeClassifier(async () => {
        throw new ClassifierResponseError(
          "classifier result invalid:\nsegments[0].what: bad",
          rawResponse,
        );
      });
      const logs: string[] = [];
      await runOnce(database, makeConfig(dir), config, classifier, {
        now: "2026-09-04T15:21:00.000Z",
        log: (line) => logs.push(line),
      });

      const job = database.query("SELECT state, error FROM w5_jobs").get() as {
        state: string;
        error: string;
      };
      expect(job.state).toBe("failed");
      expect(job.error.startsWith("classifier result invalid:\nsegments[0].what: bad")).toBe(true);
      const [message, excerpt] = job.error.split(RESPONSE_EXCERPT_MARKER);
      expect(message).toBe("classifier result invalid:\nsegments[0].what: bad");
      expect(excerpt).toBe(rawResponse.slice(0, RESPONSE_EXCERPT_LENGTH));
      expect(excerpt?.length).toBe(RESPONSE_EXCERPT_LENGTH);
      // The log line stays the message alone.
      expect(logs.join("\n")).not.toContain("xxxx");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty rejected response adds no marker to the failed job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      const classifier = new FakeClassifier(async () => {
        throw new ClassifierResponseError("classifier result invalid: empty", "");
      });
      await runOnce(database, makeConfig(dir), config, classifier, {
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
      });

      const job = database.query("SELECT error FROM w5_jobs").get() as { error: string };
      expect(job.error).toBe("classifier result invalid: empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stores the classifier's sessionNote on w5_runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      const withNote: ClassifierResult = {
        ...good,
        sessionNote: "coming back to the walk order bug after lunch",
      };
      await runOnce(database, makeConfig(dir), config, new FakeClassifier(withNote), {
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
      });

      const run = database
        .query("SELECT session_note FROM w5_runs WHERE session_id = 's1'")
        .get() as { session_note: string | null };
      expect(run.session_note).toBe("coming back to the walk order bug after lunch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a session_end job closes every open stint of the session and clears the note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, {
        sessionId: "s1",
        forced: true,
        throttleMinutes: 10,
        kind: "session_end",
      });

      const withNote: ClassifierResult = { ...good, sessionNote: "a note that must not survive" };
      await runOnce(database, makeConfig(dir), config, new FakeClassifier(withNote), {
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
      });

      const open = database
        .query("SELECT COUNT(*) as count FROM stints WHERE closed_at IS NULL")
        .get() as { count: number };
      expect(open.count).toBe(0);

      const closed = database.query("SELECT close_reason FROM stints").all() as {
        close_reason: string | null;
      }[];
      expect(closed.every((row) => row.close_reason === "session_end")).toBe(true);
      expect(closed.length).toBeGreaterThan(0);

      const run = database
        .query("SELECT session_note FROM w5_runs WHERE session_id = 's1'")
        .get() as { session_note: string | null };
      expect(run.session_note).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("three windows of one session: windows 2 and 3 reuse window 1's stint, the idle gap makes window 3 continue it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      const filePath = join(dir, "s1.jsonl");
      seedThreeWindowSession(database, filePath, 2);

      // The classifier names whatever candidate the window slice offers: an open
      // stint by its alias, else the closed one it is resuming, else a new stint.
      class MemoryClassifier implements Classifier {
        public sawOpenCandidates: number[] = [];
        async classify(window: ClassifierWindow): Promise<ClassifierResult> {
          this.sawOpenCandidates.push(window.sessionOpenStints.length);
          const open = window.sessionOpenStints.at(-1) ?? null;
          const closed = window.recentStints.find((a) => a.closedAt !== null) ?? null;
          const candidate = open ?? closed ?? null;
          const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
          const last = window.messages.at(-1)?.ts ?? first;
          return {
            segments: [
              {
                startedAt: first,
                endedAt: last,
                what: "fix walk order",
                why: "ship marko-ui",
                belongs: true,
                guess: null,
                quest: null,
                stint:
                  candidate === null
                    ? "new: nothing open to reuse yet"
                    : (candidate.stintId as string),
                isSwitch: false,
                trigger: null,
                confidence: 0.9,
              },
            ],
            sessionNote: "on the walk order bug",
          };
        }
      }

      const classifier = new MemoryClassifier();
      const runAt = async (now: string, messagesSoFar: number) => {
        seedThreeWindowSession(database, filePath, messagesSoFar);
        enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10, now });
        await runOnce(database, makeConfig(dir), config, classifier, { now, log: () => {} });
      };

      await runAt("2026-09-04T15:11:00.000Z", 2);
      await runAt("2026-09-04T15:31:00.000Z", 4);
      await runAt("2026-09-04T17:41:00.000Z", 6);

      const stints = database
        .query("SELECT id, continues, close_reason FROM stints ORDER BY opened_at")
        .all() as { id: string; continues: string | null; close_reason: string | null }[];

      // Window 1 opened one stint; window 2 reused it; the idle gap closed it and
      // window 3 opened exactly one more that points back at it.
      expect(stints).toHaveLength(2);
      expect(stints[0]?.close_reason).toBe("idle");
      expect(stints[1]?.continues).toBe(stints[0]?.id);

      // Window 2 saw window 1's stint still open; window 3 saw none open (idle-closed).
      expect(classifier.sawOpenCandidates).toEqual([0, 1, 0]);

      const traceCount = database.query("SELECT COUNT(*) as count FROM traces").get() as {
        count: number;
      };
      expect(traceCount.count).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runOnce in declared mode", () => {
  test("a doubted segment is counted as a doubt in the run summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-doubts-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      const doubting: ClassifierResult = {
        segments: [
          {
            ...(good.segments[0] as ClassifierResult["segments"][number]),
            belongs: false,
            guess: "a competitor comparison",
          },
        ],
        sessionNote: null,
      };

      const result = await runOnce(
        database,
        makeConfig(dir),
        config,
        new FakeClassifier(doubting),
        {
          now: "2026-09-04T15:21:00.000Z",
          log: () => {},
        },
      );

      // The field is `doubts`, not `questConflicts`.
      expect(result.summary?.doubts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a live session that never declared still runs declared: no quest is invented", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-undeclared-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      await runOnce(database, makeConfig(dir), config, new FakeClassifier(good), {
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
      });

      // `inference_fallback` is backfill's, not a live run's: nothing is inferred.
      expect(
        (database.query("SELECT COUNT(*) as count FROM quests").get() as { count: number }).count,
      ).toBe(0);
      const stint = database.query("SELECT quest_id as questId FROM stints").get() as {
        questId: string | null;
      };
      expect(stint.questId).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runOnce drives a belongs question to the user", () => {
  test("an unforced declared run asks the doubt, and the hand-back renders from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-belongs-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));

      const store = new EventStore(database);
      database
        .query(
          `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at, origin_kind)
           VALUES ('Q1', 'hero', 'H1', 'Ship marko-ui', '86 components', 1, 1, 'started', '2026-09-01T00:00:00.000Z', 'declared')`,
        )
        .run();
      declareQuest(store, database, {
        sessionId: "s1",
        questId: "Q1",
        plan: [],
        scope: "session",
        declaredBy: "agent",
        at: "2026-09-04T14:00:00.000Z",
        heroId: "H1",
      });

      // Not forced: `askingEnabled` stays true, so `askQuestion` actually runs.
      enqueueJob(database, { sessionId: "s1", forced: false, throttleMinutes: 0 });

      const doubting: ClassifierResult = {
        segments: [
          {
            ...(good.segments[0] as ClassifierResult["segments"][number]),
            belongs: false,
            guess: "a competitor comparison",
          },
        ],
        sessionNote: null,
      };

      const result = await runOnce(
        database,
        makeConfig(dir),
        // watchTurns 1 so the two seeded user turns promote it in this same run.
        { ...config, watchTurns: 1, askMinStintMinutes: 0 },
        new FakeClassifier(doubting),
        { now: "2026-09-04T15:21:00.000Z", log: () => {} },
      );

      expect(result.summary?.doubts).toBe(1);

      // The whole point: the question reaches `asked`, which is the only state
      // `w5 context` reads. It used to stay in `watching` forever.
      const question = database.query("SELECT id, state, kind, guess FROM questions").get() as {
        id: string;
        state: string;
        kind: string;
        guess: string | null;
      };
      expect(question.kind).toBe("belongs");
      expect(question.state).toBe("asked");
      expect(question.guess).toBe("a competitor comparison");

      const handback = buildBelongsHandback(
        [{ title: "Ship marko-ui", alias: "Q1" }],
        question.guess ?? "",
        question.id,
      );
      expect(handback).toContain(
        "not part of your active quests (Ship marko-ui [Q1]) (looks like: a competitor comparison)",
      );
      expect(handback).toContain(`tempad answer ${question.id} --belongs`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The transcript of `s1` on disk, where Claude Code writes it: `<dir>/projects/<project>/<id>.jsonl`. */
function writeTranscript(dir: string): string {
  const projectDirectory = join(dir, "projects", "-w-marko-ui");
  mkdirSync(projectDirectory, { recursive: true });
  const filePath = join(projectDirectory, "s1.jsonl");
  writeFileSync(
    filePath,
    `${[
      ["m1", "2026-09-04T15:00:00.000Z", "fix walk order"],
      ["m2", "2026-09-04T15:20:00.000Z", "done"],
    ]
      .map(([uuid, ts, text]) =>
        JSON.stringify({
          type: "user",
          uuid,
          sessionId: "s1",
          timestamp: ts,
          cwd: "/w/marko-ui",
          gitBranch: "main",
          message: { role: "user", content: text },
        }),
      )
      .join("\n")}\n`,
  );
  return filePath;
}

describe("runOnce when the session has not been collected yet", () => {
  test("collects the session's transcript first, then classifies (tempad-fyl)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      writeTranscript(dir);
      expect(database.query("SELECT 1 FROM claude_sessions WHERE id = 's1'").get()).toBeNull();
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      const result = await runOnce(database, makeConfig(dir), config, new FakeClassifier(good), {
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
      });

      expect(result.summary?.traces).toBe(1);
      const job = database.query("SELECT state, error FROM w5_jobs").get() as {
        state: string;
        error: string | null;
      };
      expect(job).toEqual({ state: "done", error: null });
      expect(database.query("SELECT 1 FROM claude_sessions WHERE id = 's1'").get()).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a session with no transcript under CLAUDE_DIRS fails once, saying so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      await runOnce(database, makeConfig(dir), config, new FakeClassifier(good), {
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
      });

      const job = database.query("SELECT state, error FROM w5_jobs").get() as {
        state: string;
        error: string;
      };
      expect(job.state).toBe("failed");
      expect(job.error).toStartWith("unknown claude session: s1");
      expect(job.error).toContain("no transcript");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runOnce reaps jobs a crashed runner left running (tempad-0xk)", () => {
  test("a job running past the lease is requeued and then classified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, {
        sessionId: "s1",
        forced: true,
        now: "2026-09-04T14:00:00.000Z",
        throttleMinutes: 10,
      });
      // The first runner claimed it and died.
      claimNextJob(database, "2026-09-04T14:01:00.000Z");

      const logs: string[] = [];
      const result = await runOnce(database, makeConfig(dir), config, new FakeClassifier(good), {
        now: "2026-09-04T15:21:00.000Z",
        log: (line) => logs.push(line),
      });

      expect(result.ran).toBe(true);
      expect(result.summary?.traces).toBe(1);
      const job = database.query("SELECT state, attempts FROM w5_jobs").get() as {
        state: string;
        attempts: number;
      };
      expect(job).toEqual({ state: "done", attempts: 2 });
      expect(logs.some((line) => line.includes("reaped"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a job still inside its lease is left alone", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    enqueueJob(database, {
      sessionId: "s1",
      forced: true,
      now: "2026-09-04T15:00:00.000Z",
      throttleMinutes: 10,
    });
    claimNextJob(database, "2026-09-04T15:00:00.000Z");

    const result = await runOnce(database, makeConfig("/tmp"), config, new FakeClassifier(good), {
      now: new Date(
        Date.parse("2026-09-04T15:00:00.000Z") + (JOB_LEASE_MINUTES - 1) * 60_000,
      ).toISOString(),
      log: () => {},
    });

    expect(result.ran).toBe(false);
    expect((database.query("SELECT state FROM w5_jobs").get() as { state: string }).state).toBe(
      "running",
    );
  });

  test("a job that already used every attempt fails instead of looping forever", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    enqueueJob(database, {
      sessionId: "s1",
      forced: true,
      now: "2026-09-04T14:00:00.000Z",
      throttleMinutes: 10,
    });
    database.query("UPDATE w5_jobs SET attempts = ?").run(JOB_MAX_ATTEMPTS - 1);
    claimNextJob(database, "2026-09-04T14:01:00.000Z");

    const result = await runOnce(database, makeConfig("/tmp"), config, new FakeClassifier(good), {
      now: "2026-09-04T15:21:00.000Z",
      log: () => {},
    });

    expect(result.ran).toBe(false);
    const job = database.query("SELECT state, error FROM w5_jobs").get() as {
      state: string;
      error: string;
    };
    expect(job.state).toBe("failed");
    expect(job.error).toContain("lease expired");
    expect(job.error).toContain(`${JOB_MAX_ATTEMPTS} attempts`);
  });
});
