import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import type { W5Config } from "../../src/intent/config";
import { declareQuest } from "../../src/intent/declarations";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { backfill, planBackfillWindows, selectBackfillSessions } from "../../src/w5/backfill";
import type { Classifier, ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";
import { buildSystemPrompt, buildUserPrompt } from "../../src/w5/prompt";

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

function makeConfig(): Config {
  return {
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
}

class FakeClassifier implements Classifier {
  public calls = 0;
  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    this.calls += 1;
    const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
    const last = window.messages.at(-1)?.ts ?? first;
    return {
      segments: [
        {
          startedAt: first,
          endedAt: last,
          what: "work",
          why: "ship",
          belongs: true,
          guess: null,
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
    };
  }
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

function seedSession(
  database: ReturnType<typeof openDatabase>,
  input: { id: string; endedAt: string; messageTimestamps?: string[]; hostSlug?: string },
) {
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES (?, '/c', 'p', ?, '/w/p', 'personal', 'p', 't', 'main', ?, ?, 1, 0, '[]', ?, ?)`,
    )
    .run(
      input.id,
      `/c/p/${input.id}.jsonl`,
      input.endedAt,
      input.endedAt,
      input.hostSlug ?? "host",
      input.endedAt,
    );
  const timestamps = input.messageTimestamps ?? [input.endedAt];
  for (const [index, ts] of timestamps.entries()) {
    database
      .query(
        "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES (?, ?, ?, 'user', 0, 'work')",
      )
      .run(`${input.id}-m${index}`, input.id, ts);
  }
}

describe("backfill", () => {
  test("classifies both sessions, a second run classifies none, asking disabled leaves no questions", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });
    seedSession(database, { id: "s2", endedAt: "2026-09-04T16:00:00.000Z" });

    const classifier = new FakeClassifier();
    const logs: string[] = [];

    const firstResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(firstResult.sessionsClassified).toBe(2);
    expect(firstResult.windowsFailed).toBe(0);
    expect(classifier.calls).toBe(2);

    const questionCount = database.query("SELECT COUNT(*) as count FROM questions").get() as {
      count: number;
    };
    expect(questionCount.count).toBe(0);

    const secondResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(secondResult.sessionsClassified).toBe(0);
    expect(secondResult.windowsClassified).toBe(0);
  });

  test("hostSlug limits backfill to sessions that ran on that host; unset classifies every host", async () => {
    const seed = () => {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSession(database, {
        id: "here-1",
        endedAt: "2026-09-04T15:00:00.000Z",
        hostSlug: "host-a",
      });
      seedSession(database, {
        id: "there",
        endedAt: "2026-09-04T15:30:00.000Z",
        hostSlug: "host-b",
      });
      seedSession(database, {
        id: "here-2",
        endedAt: "2026-09-04T16:00:00.000Z",
        hostSlug: "host-a",
      });
      return database;
    };
    const classifiedSessions = (database: ReturnType<typeof openDatabase>) =>
      (
        database.query("SELECT DISTINCT session_id FROM traces ORDER BY session_id").all() as {
          session_id: string;
        }[]
      ).map((row) => row.session_id);

    const local = seed();
    const localResult = await backfill(local, makeConfig(), config, new FakeClassifier(), {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
      hostSlug: "host-a",
    });
    expect(localResult.sessionsClassified).toBe(2);
    expect(classifiedSessions(local)).toEqual(["here-1", "here-2"]);

    // Combined with an explicit range, the host filter still applies.
    const ranged = seed();
    const rangedResult = await backfill(ranged, makeConfig(), config, new FakeClassifier(), {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
      from: "2026-09-04T00:00:00.000Z",
      to: "2026-09-04T15:45:00.000Z",
      hostSlug: "host-b",
    });
    expect(rangedResult.sessionsClassified).toBe(1);
    expect(classifiedSessions(ranged)).toEqual(["there"]);

    const unknownHost = seed();
    const noneResult = await backfill(unknownHost, makeConfig(), config, new FakeClassifier(), {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
      hostSlug: "host-z",
    });
    expect(noneResult.sessionsClassified).toBe(0);

    const everyHost = seed();
    const everyResult = await backfill(everyHost, makeConfig(), config, new FakeClassifier(), {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
    });
    expect(everyResult.sessionsClassified).toBe(3);
    expect(classifiedSessions(everyHost)).toEqual(["here-1", "here-2", "there"]);
  });

  test("coverage is segment-independent: a window a classifier splits into 2+ segments is still recognized as covered on the next run", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });

    class TwoSegmentClassifier implements Classifier {
      public calls = 0;
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        this.calls += 1;
        const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        const mid = new Date((Date.parse(first) + Date.parse(last)) / 2).toISOString();
        return {
          segments: [
            {
              startedAt: first,
              endedAt: mid,
              what: "work part 1",
              why: "ship",
              belongs: true,
              guess: null,
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
            {
              startedAt: mid,
              endedAt: last,
              what: "work part 2",
              why: "ship",
              belongs: true,
              guess: null,
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
        };
      }
    }

    const classifier = new TwoSegmentClassifier();
    const logs: string[] = [];

    const firstResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(firstResult.windowsClassified).toBe(1);
    // Two segments -> two traces, neither of which individually spans the
    // whole window -- the bug this test guards against would have neither
    // trace match the window's exact bounds, so the window looks uncovered
    // forever and gets reclassified every run.
    const traceCount = database.query("SELECT COUNT(*) as count FROM traces").get() as {
      count: number;
    };
    expect(traceCount.count).toBe(2);

    const secondResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(secondResult.windowsClassified).toBe(0);
    expect(secondResult.windowsSkipped).toBe(1);
    expect(classifier.calls).toBe(1);
  });

  test("legacy fallback: a live trace nested in the window's bounds counts as covered even with no w5_windows row", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    // Window spans 15:00-15:20 (two messages); the legacy trace is nested
    // strictly inside it (15:05-15:15), as a real pre-upgrade trace's bounds
    // (from classifier segment timestamps, not the raw chunk bounds) often
    // are.
    seedSession(database, {
      id: "s1",
      endedAt: "2026-09-04T15:20:00.000Z",
      messageTimestamps: ["2026-09-04T15:00:00.000Z", "2026-09-04T15:20:00.000Z"],
    });

    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "stint.opened",
        subject: "A1",
        payload: { outcome: "work" },
        at: "2026-09-04T15:05:00.000Z",
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "trace.recorded",
        subject: "T1",
        sessionId: "s1",
        payload: {
          stint: "A1",
          tool: "claude-code",
          place: "p",
          source: "session",
          started_at: "2026-09-04T15:05:00.000Z",
          ended_at: "2026-09-04T15:15:00.000Z",
          who: "hero",
          what: "work",
          why: "ship",
          where: "personal/p",
          how: "claude-code",
          confidence: 0.9,
          classified_by: "assistant",
        },
      }),
    );
    // No window.classified event / w5_windows row -- this trace predates the
    // primary coverage mechanism, as every trace in the real database does.

    const windowRowCount = database.query("SELECT COUNT(*) as count FROM w5_windows").get() as {
      count: number;
    };
    expect(windowRowCount.count).toBe(0);

    const classifier = new FakeClassifier();
    const logs: string[] = [];

    const result = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(result.windowsClassified).toBe(0);
    expect(result.windowsSkipped).toBe(1);
    expect(classifier.calls).toBe(0);
  });

  test("a failed final window does not stop earlier windows and is retried next run", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    // Two windows spaced 40 minutes apart (> windowMinutes = 30). The second (last)
    // window fails, mirroring the real incident where the tail window timed out.
    seedSession(database, {
      id: "s1",
      endedAt: "2026-09-04T15:40:00.000Z",
      messageTimestamps: ["2026-09-04T15:00:00.000Z", "2026-09-04T15:40:00.000Z"],
    });

    class FlakyClassifier implements Classifier {
      public calls = 0;
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        this.calls += 1;
        // Fail every attempt on the second window (calls 2 and 3: initial + retry)
        // during the first backfill run; succeed on the retried run (call 4).
        if (this.calls === 2 || this.calls === 3) {
          throw new Error("boom");
        }
        const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "work",
              why: "ship",
              belongs: true,
              guess: null,
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
        };
      }
    }

    const classifier = new FlakyClassifier();
    const logs: string[] = [];

    const firstResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T18:00:00.000Z",
      log: (line) => logs.push(line),
    });

    // First window succeeds (call 1). Second (last) window fails twice
    // (calls 2, 3: initial + retry), counted as one failed window.
    expect(firstResult.windowsClassified).toBe(1);
    expect(firstResult.windowsFailed).toBe(1);
    expect(firstResult.sessionsClassified).toBe(1);
    expect(logs.some((line) => line.includes("backfill: failed s1 window 1: boom"))).toBe(true);

    const traceCountAfterFirstRun = database
      .query("SELECT COUNT(*) as count FROM traces")
      .get() as {
      count: number;
    };
    expect(traceCountAfterFirstRun.count).toBe(1);

    // Only the failed second window is retried; the first window's trace already
    // covers it, so it is not reprocessed.
    const secondResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T18:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(secondResult.sessionsSkipped).toBe(0);
    expect(secondResult.windowsClassified).toBe(1);
    expect(secondResult.windowsFailed).toBe(0);
    expect(classifier.calls).toBe(4);
  });

  test("all windows failing yields sessionsClassified=0 and windowsFailed>0", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });

    class AlwaysFailsClassifier implements Classifier {
      async classify(): Promise<ClassifierResult> {
        throw new Error("always fails");
      }
    }

    const classifier = new AlwaysFailsClassifier();
    const logs: string[] = [];

    const result = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(result.sessionsClassified).toBe(0);
    expect(result.windowsFailed).toBe(1);
    expect(result.windowsClassified).toBe(0);
  });

  test("each chunk gets a fresh slice: chunk 2 sees chunk 1's stint and chunk 1's session note", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    // Two chunks: more than throttleMinutes * 3 = 30 minutes apart so chunkByWindow
    // splits them, but less than activityIdleMinutes = 45 apart so chunk 1's stint
    // is still open when chunk 2 is classified.
    seedSession(database, {
      id: "s1",
      endedAt: "2026-09-04T15:40:00.000Z",
      messageTimestamps: ["2026-09-04T15:00:00.000Z", "2026-09-04T15:40:00.000Z"],
    });

    /** Records the slice each chunk was handed, and reuses whatever it is offered. */
    class SliceRecordingClassifier implements Classifier {
      public seen: {
        openStints: string[];
        recentStints: string[];
        previousSessionNote: string | null;
        aliases: Record<string, string>;
      }[] = [];

      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        this.seen.push({
          openStints: window.sessionOpenStints.map((a) => a.stintId),
          recentStints: window.recentStints.map((a) => a.stintId),
          previousSessionNote: window.previousSessionNote,
          aliases: window.openStintAliases,
        });
        const open = window.sessionOpenStints.at(-1) ?? null;
        const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "work",
              why: "ship",
              belongs: true,
              guess: null,
              matchedQuest: null,
              proposedQuest: null,
              matchedStint: open?.stintId ?? null,
              continuesStint: null,
              newStintReason: open === null ? "nothing open to reuse yet" : null,
              isSwitch: false,
              trigger: null,
              confidence: 0.9,
              questions: [],
            },
          ],
          sessionNote: `note from chunk ${this.seen.length}`,
        };
      }
    }

    const classifier = new SliceRecordingClassifier();
    const result = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
    });

    expect(result.windowsClassified).toBe(2);
    expect(classifier.seen).toHaveLength(2);

    // Chunk 1 starts cold; chunk 2 must see what chunk 1 actually produced.
    expect(classifier.seen[0]?.openStints).toEqual([]);
    expect(classifier.seen[0]?.previousSessionNote).toBeNull();

    const stint = database.query("SELECT id FROM stints").get() as { id: string };
    // This session declares nothing, so backfill falls back to inference mode,
    // where the slice keeps real ids and no alias map is built.
    expect(classifier.seen[1]?.openStints).toEqual([stint.id]);
    expect(classifier.seen[1]?.aliases).toEqual({});
    expect(classifier.seen[1]?.previousSessionNote).toBe("note from chunk 1");

    // Chunk 2 reused chunk 1's stint rather than opening a second one.
    const stintCount = database.query("SELECT COUNT(*) as count FROM stints").get() as {
      count: number;
    };
    expect(stintCount.count).toBe(1);

    // The last chunk's note is persisted for whatever runs next.
    const run = database
      .query("SELECT session_note FROM w5_runs WHERE session_id = 's1'")
      .get() as { session_note: string | null } | null;
    expect(run?.session_note).toBe("note from chunk 2");
  });

  test("force bypasses w5_windows coverage and reclassifies an already-covered window", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });

    const classifier = new FakeClassifier();
    const logs: string[] = [];

    const firstResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });
    expect(firstResult.windowsClassified).toBe(1);

    const secondResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
      force: true,
    });

    expect(secondResult.windowsClassified).not.toBe(0);
    expect(secondResult.windowsSkipped).toBe(0);
  });

  test("to bounds each session's message window, not just the session query", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    // Session's own ended_at sits strictly before `to` so it is selected by
    // the session query, but claude_messages (the source `buildWindow`
    // actually reads) has messages both before and after `to` -- e.g. from a
    // later resync of the same session file. The window fed to the
    // classifier must stop before `to`, not run to the session's actual last
    // message. `to` is an exclusive upper bound (see `eval.ts`'s
    // `normalizeEvalRange`), so it sits strictly after the messages meant to
    // be included and strictly before (or at) the one meant to be excluded.
    seedSession(database, {
      id: "s1",
      endedAt: "2026-09-04T15:09:00.000Z",
      messageTimestamps: [
        "2026-09-04T15:00:00.000Z",
        "2026-09-04T15:05:00.000Z",
        "2026-09-04T15:40:00.000Z",
      ],
    });

    const classifier = new FakeClassifier();
    const logs: string[] = [];

    await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
      to: "2026-09-04T15:10:00.000Z",
    });

    const traces = database
      .query("SELECT started_at as startedAt, ended_at as endedAt FROM traces")
      .all() as { startedAt: string; endedAt: string }[];
    expect(traces.length).toBe(1);
    expect((traces[0] as { endedAt: string }).endedAt < "2026-09-04T15:10:00.000Z").toBe(true);
  });
});

describe("chronological window order", () => {
  /** A session whose `started_at` and `ended_at` differ, so the two can interleave. */
  function seedSpanningSession(
    database: ReturnType<typeof openDatabase>,
    input: { id: string; startedAt: string; endedAt: string; messageTimestamps: string[] },
  ) {
    database
      .query(
        `INSERT INTO claude_sessions
          (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
           started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES (?, '/c', 'p', ?, '/w/p', 'personal', 'p', 't', 'main', ?, ?, 1, 0, '[]', 'host', ?)`,
      )
      .run(input.id, `/c/p/${input.id}.jsonl`, input.startedAt, input.endedAt, input.endedAt);
    for (const [index, ts] of input.messageTimestamps.entries()) {
      database
        .query(
          "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES (?, ?, ?, 'user', 0, 'work')",
        )
        .run(`${input.id}-m${index}`, input.id, ts);
    }
  }

  test("windows of two interleaved sessions are classified in chronological order", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);

    // Session A's windows sit at 10:00 and 12:00; session B's single window at
    // 11:00 falls between them. Chunks are split by throttleMinutes*3 = 30 min.
    seedSpanningSession(database, {
      id: "sA",
      startedAt: "2026-09-04T10:00:00.000Z",
      endedAt: "2026-09-04T12:00:00.000Z",
      messageTimestamps: ["2026-09-04T10:00:00.000Z", "2026-09-04T12:00:00.000Z"],
    });
    seedSpanningSession(database, {
      id: "sB",
      startedAt: "2026-09-04T11:00:00.000Z",
      endedAt: "2026-09-04T11:00:00.000Z",
      messageTimestamps: ["2026-09-04T11:00:00.000Z"],
    });

    const seen: { sessionId: string; startedAt: string }[] = [];
    class RecordingClassifier implements Classifier {
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        const first = window.messages[0]?.ts ?? "2026-09-04T10:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        seen.push({ sessionId: window.sessionId, startedAt: first });
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "work",
              why: "ship",
              belongs: true,
              guess: null,
              matchedQuest: null,
              proposedQuest: null,
              matchedStint: null,
              continuesStint: null,
              newStintReason: "new work",
              isSwitch: false,
              trigger: null,
              confidence: 0.9,
              questions: [],
            },
          ],
          sessionNote: null,
        };
      }
    }

    const result = await backfill(database, makeConfig(), config, new RecordingClassifier(), {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
    });

    expect(result.windowsClassified).toBe(3);
    expect(seen).toEqual([
      { sessionId: "sA", startedAt: "2026-09-04T10:00:00.000Z" },
      { sessionId: "sB", startedAt: "2026-09-04T11:00:00.000Z" },
      { sessionId: "sA", startedAt: "2026-09-04T12:00:00.000Z" },
    ]);
  });

  test("each session's overlap tail still comes from its own previous chunk", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);

    seedSpanningSession(database, {
      id: "sA",
      startedAt: "2026-09-04T10:00:00.000Z",
      endedAt: "2026-09-04T12:00:00.000Z",
      messageTimestamps: ["2026-09-04T10:00:00.000Z", "2026-09-04T12:00:00.000Z"],
    });
    seedSpanningSession(database, {
      id: "sB",
      startedAt: "2026-09-04T11:00:00.000Z",
      endedAt: "2026-09-04T11:00:00.000Z",
      messageTimestamps: ["2026-09-04T11:00:00.000Z"],
    });

    const overlaps: { sessionId: string; overlap: string[] }[] = [];
    class OverlapRecordingClassifier implements Classifier {
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        const first = window.messages[0]?.ts ?? "2026-09-04T10:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        overlaps.push({
          sessionId: window.sessionId,
          overlap: window.overlapMessages.map((message) => message.ts),
        });
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "work",
              why: "ship",
              belongs: true,
              guess: null,
              matchedQuest: null,
              proposedQuest: null,
              matchedStint: null,
              continuesStint: null,
              newStintReason: "new work",
              isSwitch: false,
              trigger: null,
              confidence: 0.9,
              questions: [],
            },
          ],
          sessionNote: null,
        };
      }
    }

    await backfill(database, makeConfig(), config, new OverlapRecordingClassifier(), {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
    });

    // sA's second window (classified last) carries sA's own earlier message as
    // its tail, not sB's 11:00 message that was classified just before it.
    expect(overlaps.at(-1)).toEqual({
      sessionId: "sA",
      overlap: ["2026-09-04T10:00:00.000Z"],
    });
  });
});

describe("backfill and declared quests", () => {
  test("a session that never declares falls back to inference and its quests are inferred", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });

    /** Proposes a quest, as the pre-verifier classifier did. */
    class ProposingClassifier implements Classifier {
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
        return {
          segments: [
            {
              startedAt: first,
              endedAt: window.messages.at(-1)?.ts ?? first,
              what: "work",
              why: "ship",
              belongs: true,
              guess: null,
              matchedQuest: null,
              proposedQuest: {
                title: "Inferred quest",
                outcome: "guessed from the transcript",
                commitment: "exploratory",
              },
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
        };
      }
    }

    await backfill(database, makeConfig(), config, new ProposingClassifier(), {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
    });

    const quest = database.query("SELECT title, origin_kind as originKind FROM quests").get() as {
      title: string;
      originKind: string;
    } | null;
    expect(quest?.title).toBe("Inferred quest");
    expect(quest?.originKind).toBe("inferred");
  });

  test("inference_fallback false leaves an undeclared session's traces unattributed", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });

    const result = await backfill(
      database,
      makeConfig(),
      { ...config, inferenceFallback: false },
      new FakeClassifier(),
      { days: 15, now: "2026-09-04T17:00:00.000Z", log: () => {} },
    );

    expect(
      (database.query("SELECT COUNT(*) as count FROM quests").get() as { count: number }).count,
    ).toBe(0);
    const stints = database.query("SELECT quest_id as questId FROM stints").all() as {
      questId: string | null;
    }[];
    expect(stints.length).toBeGreaterThan(0);
    expect(stints.every((stint) => stint.questId === null)).toBe(true);
    expect(result.sessionsDeclared).toBe(1);
    expect(result.sessionsInferred).toBe(0);
  });

  test("a session that declares partway through never gets an inferred quest", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, {
      id: "s1",
      endedAt: "2026-09-04T16:00:00.000Z",
      messageTimestamps: ["2026-09-04T15:00:00.000Z", "2026-09-04T16:00:00.000Z"],
    });
    const hero = database.query("SELECT id FROM heroes").get() as { id: string };
    database
      .query(
        `INSERT INTO quests (id, owner_kind, owner_id, title, outcome, confirmed, revision, state, created_at, origin_kind)
         VALUES ('Q1', 'hero', ?, 'Declared quest', 'stated up front', 1, 1, 'started', '2026-09-01T00:00:00.000Z', 'declared')`,
      )
      .run(hero.id);

    // Declared only near the end of the session; earlier windows precede it.
    declareQuest(new EventStore(database), database, {
      sessionId: "s1",
      questId: "Q1",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T15:59:00.000Z",
      heroId: hero.id,
    });

    const result = await backfill(database, makeConfig(), config, new FakeClassifier(), {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
    });

    // The whole span runs declared: the fallback is only for sessions that
    // declare nothing, ever, so no inferred quest is ever created here.
    const inferred = database
      .query("SELECT COUNT(*) as count FROM quests WHERE origin_kind = 'inferred'")
      .get() as { count: number };
    expect(inferred.count).toBe(0);
    expect(result.sessionsDeclared).toBe(1);
    expect(result.sessionsInferred).toBe(0);
  });

  test("the result field is named doubts", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });

    const result = await backfill(database, makeConfig(), config, new FakeClassifier(), {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
    });

    expect(result.doubts).toBe(0);
    expect("questConflicts" in result).toBe(false);
  });
});

describe("backfill hands the classifier the prompt its mode needs", () => {
  test("a never-declaring session's window is classified with the inference prompt", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });

    /**
     * Renders the real prompts from the window it is handed, instead of
     * hand-returning a result. Every other classifier in this file bypasses
     * `buildSystemPrompt`/`buildUserPrompt` entirely, which is exactly how a
     * verifier-only prompt reached the inference path unnoticed.
     */
    class PromptRecordingClassifier implements Classifier {
      public systemPrompts: string[] = [];
      public userPrompts: string[] = [];
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        this.systemPrompts.push(buildSystemPrompt(window.mode));
        this.userPrompts.push(buildUserPrompt(window));
        const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
        return {
          segments: [
            {
              startedAt: first,
              endedAt: window.messages.at(-1)?.ts ?? first,
              what: "work",
              why: "ship",
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
        };
      }
    }

    const classifier = new PromptRecordingClassifier();
    await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
    });

    expect(classifier.systemPrompts.length).toBeGreaterThan(0);
    for (const prompt of classifier.systemPrompts) {
      // The fallback's apply path reads these, so the model must be asked for them.
      expect(prompt).toContain('"matchedQuest"');
      expect(prompt).toContain('"proposedQuest"');
      expect(prompt).not.toContain('"belongs"');
    }
    for (const prompt of classifier.userPrompts) {
      expect(prompt).toContain("open quests:");
      expect(prompt).not.toContain("your declared quest");
    }
  });
});

describe("planBackfillWindows", () => {
  // `tempad scry` recommends a backfill from this plan, so it must predict exactly what a real run does.
  test("predicts the windows a real run classifies and the ones it skips, for the same host filter", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    // "long" has three 30-minute windows (10:00-10:20, 11:10, 12:30).
    seedSession(database, {
      id: "long",
      endedAt: "2026-09-04T13:00:00.000Z",
      hostSlug: "host-a",
      messageTimestamps: [
        "2026-09-04T10:00:00.000Z",
        "2026-09-04T10:20:00.000Z",
        "2026-09-04T11:10:00.000Z",
        "2026-09-04T12:30:00.000Z",
      ],
    });
    seedSession(database, { id: "short", endedAt: "2026-09-04T15:00:00.000Z", hostSlug: "host-a" });
    seedSession(database, {
      id: "elsewhere",
      endedAt: "2026-09-04T15:30:00.000Z",
      hostSlug: "host-b",
    });
    const now = "2026-09-05T00:00:00.000Z";
    const cutoff = "2026-09-01T00:00:00.000Z";
    const windowMinutes = config.throttleMinutes * 3;

    // Only sessions that ended before 14:00 get classified: "long" is covered, the others are not.
    await backfill(database, makeConfig(), config, new FakeClassifier(), {
      days: 15,
      now,
      log: () => {},
      to: "2026-09-04T14:00:00.000Z",
    });

    for (const hostSlug of ["host-a", undefined]) {
      const sessions = selectBackfillSessions(database, { cutoff, hostSlug });
      const planned = planBackfillWindows(database, sessions, { windowMinutes });
      const covered = planned.filter((window) => window.covered).length;
      const pending = planned.filter((window) => !window.covered).length;
      expect(covered).toBe(3);

      // The real run goes on a copy, so the next loop iteration plans against the same state.
      const copyPath = join(mkdtempSync(join(tmpdir(), "tempad-plan-")), "copy.db");
      database.exec(`VACUUM INTO '${copyPath}'`);
      const clone = new Database(copyPath);
      const result = await backfill(clone, makeConfig(), config, new FakeClassifier(), {
        days: 15,
        now,
        log: () => {},
        hostSlug,
      });
      expect(result.windowsClassified).toBe(pending);
      expect(result.windowsSkipped).toBe(covered);
      expect(pending).toBe(hostSlug === undefined ? 2 : 1);
      clone.close();
      rmSync(dirname(copyPath), { recursive: true, force: true });
    }
  });

  test("a trace that predates w5_windows still covers its window, and a retracted one does not", () => {
    const database = openDatabase(":memory:");
    seedSession(database, {
      id: "old",
      endedAt: "2026-09-04T10:20:00.000Z",
      messageTimestamps: ["2026-09-04T10:00:00.000Z", "2026-09-04T10:20:00.000Z"],
    });
    const sessions = selectBackfillSessions(database, { cutoff: "2026-09-01T00:00:00.000Z" });
    ensureTables(database);
    const insertTrace = (id: string, retractedAt: string | null) =>
      database
        .query(
          `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at, retracted_at)
           VALUES (?, 's', 't', 'p', 'claude', '2026-09-04T10:00:00.000Z', '2026-09-04T10:20:00.000Z', 'w', 'w', 'w', 'w', 'w', 0.9, 'assistant', 'old', '2026-09-04T11:00:00.000Z', ?)`,
        )
        .run(id, retractedAt);
    insertTrace("T1", "2026-09-04T12:00:00.000Z");
    expect(planBackfillWindows(database, sessions, { windowMinutes: 30 })[0]?.covered).toBe(false);
    insertTrace("T2", null);
    expect(planBackfillWindows(database, sessions, { windowMinutes: 30 })[0]?.covered).toBe(true);
  });
});
