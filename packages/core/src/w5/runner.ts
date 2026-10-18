import type { Database } from "bun:sqlite";
import { findSessionTranscript, syncOneSessionFile } from "../collect/claude";
import type { LoadedConfig } from "../config/env";
import type { W5Config } from "../intent/config";
import { registerAllProjections } from "../intent/projections/register";
import { EventStore } from "../intent/store";
import { type AppliedSummary, applyResult } from "./apply";
import type { Classifier } from "./classifier";
import { describeJobFailure } from "./classifier-shared";
import { claimNextJob, claimOf, completeJob, failJob, holdsClaim, reapStaleJobs } from "./jobs";
import { closeIdleStints, closeSessionStints } from "./lifecycle";
import { advanceQuestions } from "./questions";
import { buildWindow, findSessionFile } from "./window";

registerAllProjections();

class LostClaimError extends Error {
  constructor() {
    super("claim lost while completing the job");
  }
}

export interface RunOnceOptions {
  now?: string;
  /** Wall clock read when a job settles (`w5_jobs.finished_at`); injected by tests, `now` is the run's start. */
  clock?: () => string;
  log: (line: string) => void;
  /** Called before each job is claimed; the runner touches its lock here. */
  beforeJob?: () => void;
}

export interface RunOnceResult {
  ran: boolean;
  sessionId?: string;
  summary?: AppliedSummary;
}

function sessionIsStored(database: Database, sessionId: string): boolean {
  return database.query("SELECT 1 FROM claude_sessions WHERE id = ?").get(sessionId) !== null;
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
  options.beforeJob?.();
  const now = options.now ?? new Date().toISOString();
  const clock = options.clock ?? (() => new Date().toISOString());
  const reaped = reapStaleJobs(database, now);
  if (reaped.requeued + reaped.failed > 0) {
    options.log(
      `w5 reaped ${reaped.requeued + reaped.failed} job(s) left running: ${reaped.requeued} requeued, ${reaped.failed} failed`,
    );
  }
  const job = claimNextJob(database, now);
  if (!job) return { ran: false };

  const store = new EventStore(database);
  const claim = claimOf(job);
  if (claim === null) throw new Error(`job ${job.id} was claimed without a claim time`);

  try {
    // The hook fires on the session's first Stop, which can be before any
    // `tempad sync claude`: the transcript is on disk but the session is not in
    // the database. Find the file ourselves; nothing is retried later because
    // waiting does not help (the collector runs on its own schedule, and a
    // transcript outside CLAUDE_DIRS never turns up).
    const filePath =
      findSessionFile(database, job.sessionId) ??
      findSessionTranscript(config.claudeDirs, job.sessionId);
    if (filePath !== null) {
      await syncOneSessionFile(database, config, filePath);
    }
    if (!sessionIsStored(database, job.sessionId)) {
      throw new Error(
        `unknown claude session: ${job.sessionId} (no transcript found under CLAUDE_DIRS, or it holds no messages)`,
      );
    }

    const runRow = database
      .query("SELECT last_message_ts FROM w5_runs WHERE session_id = ?")
      .get(job.sessionId) as { last_message_ts: string | null } | null;
    const sinceTs = runRow?.last_message_ts ?? null;

    // Idle-close before the window is built, so the classifier's "open stints
    // this session" slice never offers a stint that idleness already ended. It
    // appends events (which cannot be removed), so like the result below it runs
    // in a transaction that first checks this runner still holds the claim, and
    // reads the open stints inside it: a runner that was reaped, or that races
    // the one that re-claimed the job, cannot close the same stint twice. Losing
    // the claim here only skips the close; the check after classification is
    // what discards the result.
    const closeIdle = database.transaction(() => {
      if (!holdsClaim(database, job.id, claim)) return;
      closeIdleStints(store, database, {
        sessionId: job.sessionId,
        windowStartedAt: windowStartedAt(database, job.sessionId, sinceTs) ?? now,
        idleMinutes: intentConfig.stintIdleMinutes,
        stintMinMinutes: intentConfig.stintMinMinutes,
      });
    });
    closeIdle.immediate();

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
      memoryQuests: intentConfig.memoryQuests,
      overlapMessages: intentConfig.overlapMessages,
      // A live run classifies up to the present, so `now` is its window end: it
      // bounds nothing that exists today but keeps the rule identical to backfill's.
      windowEnd: now,
    });

    const result = await classifier.classify(window);
    // The classifier call above can outlast the lease (a laptop asleep mid-run
    // looks dead to the next runner, which reaps and re-claims the job). Every
    // event this job writes, and the job's own completion, therefore happen in
    // one transaction that first checks this runner still holds the claim: a
    // runner that lost it writes nothing, and events are never removable.
    const finish = database.transaction((): AppliedSummary | null => {
      if (!holdsClaim(database, job.id, claim)) return null;
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
      // The claim was checked above in this same transaction, so this cannot
      // fail; if it ever does, throwing rolls back every event applied here.
      if (
        !completeJob(database, job.id, lastMessage?.ts ?? sinceTs, now, sessionNote, claim, clock())
      ) {
        throw new LostClaimError();
      }
      return summary;
    });
    const summary = finish.immediate();
    if (summary === null) {
      options.log(
        `w5 job ${job.id} for session ${job.sessionId} was reaped and claimed again while it ran; discarding its result`,
      );
      return { ran: true, sessionId: job.sessionId };
    }

    return { ran: true, sessionId: job.sessionId, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `failJob` settles the job only while this runner still holds the claim; if
    // it does not, the failure belongs to a claim that is no longer ours and
    // another runner owns the job, so say that instead of reporting a failed run.
    if (!failJob(database, job.id, describeJobFailure(error), claim, clock())) {
      options.log(
        `w5 job ${job.id} for session ${job.sessionId} lost its claim before it could be marked failed (${message}); leaving it to the runner that holds it`,
      );
    } else {
      options.log(`w5 run failed for session ${job.sessionId}: ${message}`);
    }
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
