import type { Database } from "bun:sqlite";
import { syncOneSessionFile } from "../collect/claude";
import type { LoadedConfig } from "../config/env";
import type { W5Config } from "../intent/config";
import { registerAllProjections } from "../intent/projections/register";
import { EventStore } from "../intent/store";
import { type AppliedSummary, applyResult } from "./apply";
import type { Classifier } from "./classifier";
import { describeJobFailure } from "./classifier-shared";
import { claimNextJob, completeJob, failJob } from "./jobs";
import { closeIdleStints, closeSessionStints } from "./lifecycle";
import { advanceQuestions } from "./questions";
import { buildWindow, findSessionFile } from "./window";

registerAllProjections();

export interface RunOnceOptions {
  now?: string;
  log: (line: string) => void;
}

export interface RunOnceResult {
  ran: boolean;
  sessionId?: string;
  summary?: AppliedSummary;
}

function countUserMessages(database: Database, sessionId: string, sinceTs: string | null): number {
  const row =
    sinceTs !== null
      ? (database
          .query(
            "SELECT COUNT(*) as count FROM claude_messages WHERE session_id = ? AND ts > ? AND role = 'user'",
          )
          .get(sessionId, sinceTs) as { count: number })
      : (database
          .query(
            "SELECT COUNT(*) as count FROM claude_messages WHERE session_id = ? AND role = 'user'",
          )
          .get(sessionId) as { count: number });
  return row.count;
}

function sessionStintMinutes(
  database: Database,
  sessionId: string,
  sinceTs: string | null,
): number {
  const row =
    sinceTs !== null
      ? (database
          .query(
            "SELECT MIN(ts) as firstTs, MAX(ts) as lastTs FROM claude_messages WHERE session_id = ? AND ts > ?",
          )
          .get(sessionId, sinceTs) as { firstTs: string | null; lastTs: string | null })
      : (database
          .query(
            "SELECT MIN(ts) as firstTs, MAX(ts) as lastTs FROM claude_messages WHERE session_id = ?",
          )
          .get(sessionId) as { firstTs: string | null; lastTs: string | null });

  if (!row.firstTs || !row.lastTs) return 0;
  return (Date.parse(row.lastTs) - Date.parse(row.firstTs)) / 60_000;
}

/** The `ts` of the first message this run's window will contain. */
function windowStartedAt(
  database: Database,
  sessionId: string,
  sinceTs: string | null,
): string | null {
  const row =
    sinceTs !== null
      ? (database
          .query(
            "SELECT MIN(ts) as ts FROM claude_messages WHERE session_id = ? AND ts > ? AND text_preview IS NOT NULL",
          )
          .get(sessionId, sinceTs) as { ts: string | null })
      : (database
          .query(
            "SELECT MIN(ts) as ts FROM claude_messages WHERE session_id = ? AND text_preview IS NOT NULL",
          )
          .get(sessionId) as { ts: string | null });
  return row.ts;
}

export async function runOnce(
  database: Database,
  config: LoadedConfig<"claudeDirs" | "hostSlug">,
  intentConfig: W5Config,
  classifier: Classifier,
  options: RunOnceOptions,
): Promise<RunOnceResult> {
  const now = options.now ?? new Date().toISOString();
  const job = claimNextJob(database, now);
  if (!job) return { ran: false };

  const store = new EventStore(database);

  try {
    const filePath = findSessionFile(database, job.sessionId);
    if (filePath !== null) {
      await syncOneSessionFile(database, config, filePath);
    }

    const runRow = database
      .query("SELECT last_message_ts FROM w5_runs WHERE session_id = ?")
      .get(job.sessionId) as { last_message_ts: string | null } | null;
    const sinceTs = runRow?.last_message_ts ?? null;

    // Idle-close before the window is built, so the classifier's "open stints
    // this session" slice never offers a stint that idleness already ended.
    closeIdleStints(store, database, {
      sessionId: job.sessionId,
      windowStartedAt: windowStartedAt(database, job.sessionId, sinceTs) ?? now,
      idleMinutes: intentConfig.stintIdleMinutes,
      stintMinMinutes: intentConfig.stintMinMinutes,
    });

    // A live session that has never declared anything still runs in declared mode
    // (it gets a `declare` question); the inference fallback is backfill's, for
    // sessions no agent will ever resume.
    const mode = intentConfig.mode;

    const window = buildWindow(database, {
      sessionId: job.sessionId,
      mode,
      sinceTs,
      maxMessages: 200,
      memoryHours: intentConfig.memoryHours,
      memoryStints: intentConfig.memoryStints,
      overlapMessages: intentConfig.overlapMessages,
      // A live run classifies up to the present, so `now` is its window end: it
      // bounds nothing that exists today but keeps the rule identical to backfill's.
      windowEnd: now,
    });

    const result = await classifier.classify(window);
    const summary = applyResult(store, database, window, result, {
      actor: "hook",
      askingEnabled: !job.forced,
      now,
      log: options.log,
      mode,
      stintMinMinutes: intentConfig.stintMinMinutes,
    });

    if (job.kind === "session_end") {
      closeSessionStints(store, database, {
        sessionId: job.sessionId,
        now,
        stintMinMinutes: intentConfig.stintMinMinutes,
      });
    }

    const turnsSinceLastRun = countUserMessages(database, job.sessionId, sinceTs);
    const stintMinutes = sessionStintMinutes(database, job.sessionId, sinceTs);
    advanceQuestions(store, database, intentConfig, {
      sessionId: job.sessionId,
      now,
      turnsSinceLastRun,
      sessionStintMinutes: stintMinutes,
      resolvedByContext: [],
    });

    const lastMessage = window.messages.at(-1);
    // `closeSessionActivities` cleared the note for a session that just ended;
    // writing the classifier's note back would resurrect it.
    const sessionNote = job.kind === "session_end" ? null : result.sessionNote;
    completeJob(database, job.id, lastMessage?.ts ?? sinceTs, now, sessionNote);

    return { ran: true, sessionId: job.sessionId, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failJob(database, job.id, describeJobFailure(error));
    options.log(`w5 run failed for session ${job.sessionId}: ${message}`);
    return { ran: true, sessionId: job.sessionId };
  }
}

export async function drain(
  database: Database,
  config: LoadedConfig<"claudeDirs" | "hostSlug">,
  intentConfig: W5Config,
  classifier: Classifier,
  options: RunOnceOptions,
): Promise<number> {
  let count = 0;
  for (;;) {
    const result = await runOnce(database, config, intentConfig, classifier, options);
    if (!result.ran) break;
    count += 1;
  }
  return count;
}
