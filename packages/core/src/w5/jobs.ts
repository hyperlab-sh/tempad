import type { Database } from "bun:sqlite";

export interface EnqueueJobInput {
  sessionId: string;
  forced: boolean;
  now?: string;
  throttleMinutes: number;
  kind?: string;
}

export interface EnqueueJobResult {
  enqueued: boolean;
  reason?: "throttled" | "duplicate";
}

/**
 * How long a claimed job may stay `running` before its runner is presumed dead.
 * A job is bounded by the classifier timeout (`[w5].timeout_seconds`, 180 s) and
 * one JSON retry, so about 6 minutes; on the live database the slowest failed
 * job took 181 s. 30 minutes matches the runner's stale lock (`STALE_LOCK_MINUTES`
 * in `cli.ts`), so a lock and a lease stop protecting a dead runner together. A
 * `timeout_seconds` above 600 needs a longer lease than this.
 */
export const JOB_LEASE_MINUTES = 30;
/** A job claimed this many times without finishing is failed, not requeued. */
export const JOB_MAX_ATTEMPTS = 3;
/**
 * A reaped job requested longer ago than this is failed, not requeued: a live
 * run classifies "everything since the last run" as if it were happening now, so
 * a days-old job would ask questions in a long-dead session. `tempad w5 backfill`
 * is the recovery for that history.
 */
export const JOB_MAX_REQUEUE_AGE_HOURS = 24;

export interface Job {
  id: number;
  sessionId: string;
  kind: string;
  forced: boolean;
  requestedAt: string;
  claimedAt: string | null;
  attempts: number;
}

interface JobRow {
  id: number;
  session_id: string;
  kind: string;
  forced: number;
  requested_at: string;
  claimed_at: string | null;
  attempts: number;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    forced: row.forced === 1,
    requestedAt: row.requested_at,
    claimedAt: row.claimed_at,
    attempts: row.attempts,
  };
}

export function isThrottled(
  database: Database,
  sessionId: string,
  now: string,
  throttleMinutes: number,
): boolean {
  const run = database
    .query("SELECT last_run_at FROM w5_runs WHERE session_id = ?")
    .get(sessionId) as { last_run_at: string } | null;
  if (!run) return false;
  const elapsedMinutes = (Date.parse(now) - Date.parse(run.last_run_at)) / 60_000;
  return elapsedMinutes < throttleMinutes;
}

export function enqueueJob(database: Database, input: EnqueueJobInput): EnqueueJobResult {
  const now = input.now ?? new Date().toISOString();

  const kind = input.kind ?? "classify";

  const existingQueued = database
    .query("SELECT id, forced, kind FROM w5_jobs WHERE session_id = ? AND state = 'queued'")
    .get(input.sessionId) as { id: number; forced: number; kind: string } | null;

  if (existingQueued) {
    // "session_end" is monotonic: once a job is marked for session close, a
    // later "classify" (e.g. a Stop that races behind a SessionEnd) must not
    // downgrade it back.
    const nextKind = existingQueued.kind === "session_end" ? "session_end" : kind;
    if ((input.forced && existingQueued.forced === 0) || nextKind !== existingQueued.kind) {
      database
        .query("UPDATE w5_jobs SET forced = ?, kind = ? WHERE id = ?")
        .run(input.forced ? 1 : existingQueued.forced, nextKind, existingQueued.id);
    }
    return { enqueued: false, reason: "duplicate" };
  }

  if (!input.forced && isThrottled(database, input.sessionId, now, input.throttleMinutes)) {
    return { enqueued: false, reason: "throttled" };
  }

  database
    .query(
      "INSERT INTO w5_jobs (session_id, kind, forced, requested_at, state) VALUES (?, ?, ?, ?, 'queued')",
    )
    .run(input.sessionId, kind, input.forced ? 1 : 0, now);

  return { enqueued: true };
}

export function claimNextJob(database: Database, now?: string): Job | null {
  const claimedAt = now ?? new Date().toISOString();
  const row = database
    .query("SELECT id FROM w5_jobs WHERE state = 'queued' ORDER BY id ASC LIMIT 1")
    .get() as { id: number } | null;
  if (!row) return null;

  database
    .query(
      "UPDATE w5_jobs SET state = 'running', claimed_at = ?, attempts = attempts + 1 WHERE id = ?",
    )
    .run(claimedAt, row.id);

  const job = database.query("SELECT * FROM w5_jobs WHERE id = ?").get(row.id) as JobRow;
  return toJob(job);
}

export interface ReapResult {
  requeued: number;
  failed: number;
}

/**
 * Settles jobs a runner claimed and never finished (it crashed, or was killed
 * with the machine). A `running` job whose claim is older than the lease goes
 * back to `queued` for another attempt, unless it has used `JOB_MAX_ATTEMPTS`
 * or was requested more than `JOB_MAX_REQUEUE_AGE_HOURS` ago: those fail, with
 * the reason in `error`. Safe next to a live runner: only one holds `w5.lock`,
 * and a job inside its lease is never touched.
 */
export function reapStaleJobs(
  database: Database,
  now: string,
  options: { leaseMinutes?: number; maxAttempts?: number; maxAgeHours?: number } = {},
): ReapResult {
  const leaseMinutes = options.leaseMinutes ?? JOB_LEASE_MINUTES;
  const maxAttempts = options.maxAttempts ?? JOB_MAX_ATTEMPTS;
  const maxAgeHours = options.maxAgeHours ?? JOB_MAX_REQUEUE_AGE_HOURS;
  const leaseEnds = new Date(Date.parse(now) - leaseMinutes * 60_000).toISOString();
  const oldestRequeued = new Date(Date.parse(now) - maxAgeHours * 3_600_000).toISOString();

  const reap = database.transaction((): ReapResult => {
    const stale = database
      .query(
        `SELECT id, attempts, requested_at FROM w5_jobs
          WHERE state = 'running' AND COALESCE(claimed_at, requested_at) <= ?`,
      )
      .all(leaseEnds) as { id: number; attempts: number; requested_at: string }[];

    const requeue = database.query(
      "UPDATE w5_jobs SET state = 'queued', claimed_at = NULL WHERE id = ?",
    );
    const fail = database.query(
      "UPDATE w5_jobs SET state = 'failed', finished_at = ?, error = ? WHERE id = ?",
    );
    let requeued = 0;
    let failed = 0;
    for (const job of stale) {
      if (job.attempts >= maxAttempts) {
        fail.run(
          now,
          `lease expired: the runner never finished this job in ${job.attempts} attempts`,
          job.id,
        );
        failed += 1;
      } else if (job.requested_at < oldestRequeued) {
        fail.run(
          now,
          `lease expired: the runner never finished this job and it is too old to classify live; tempad w5 backfill covers its session`,
          job.id,
        );
        failed += 1;
      } else {
        requeue.run(job.id);
        requeued += 1;
      }
    }
    return { requeued, failed };
  });
  return reap.immediate();
}

/**
 * The classifier's scratch note for a session. Not an event and not rebuilt by
 * `tempad rebuild`: it is a hint carried from one window to the next, which
 * backfill needs between chunks exactly as the runner needs it between hook runs.
 */
export function writeSessionNote(
  database: Database,
  sessionId: string,
  sessionNote: string | null,
  now: string,
): void {
  database
    .query(
      `INSERT INTO w5_runs (session_id, last_run_at, last_message_ts, session_note) VALUES (?, ?, NULL, ?)
       ON CONFLICT(session_id) DO UPDATE SET session_note = excluded.session_note`,
    )
    .run(sessionId, now, sessionNote);
}

export function completeJob(
  database: Database,
  id: number,
  lastMessageTs: string | null,
  now?: string,
  sessionNote?: string | null,
): void {
  const job = database.query("SELECT session_id FROM w5_jobs WHERE id = ?").get(id) as {
    session_id: string;
  } | null;
  if (!job) return;

  const finishedAt = now ?? new Date().toISOString();

  database
    .query("UPDATE w5_jobs SET state = 'done', finished_at = ? WHERE id = ?")
    .run(finishedAt, id);

  database
    .query(
      `INSERT INTO w5_runs (session_id, last_run_at, last_message_ts, session_note) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_run_at = excluded.last_run_at,
                                             last_message_ts = excluded.last_message_ts,
                                             session_note = excluded.session_note`,
    )
    .run(job.session_id, finishedAt, lastMessageTs, sessionNote ?? null);
}

export function failJob(database: Database, id: number, error: string): void {
  const now = new Date().toISOString();
  database
    .query("UPDATE w5_jobs SET state = 'failed', finished_at = ?, error = ? WHERE id = ?")
    .run(now, error, id);
}
