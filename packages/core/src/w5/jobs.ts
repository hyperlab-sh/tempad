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

/**
 * What a runner holds while it works a job: the claim time plus the attempt
 * count, which rises on every claim, so two claims stamped with the same
 * instant still differ.
 */
export interface JobClaim {
  claimedAt: string;
  attempts: number;
}

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

export function claimOf(job: Job): JobClaim | null {
  return job.claimedAt === null ? null : { claimedAt: job.claimedAt, attempts: job.attempts };
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

/**
 * Folds a request into the session's queued job instead of adding a second row.
 * "session_end" is monotonic: once a job is marked for session close, a later
 * "classify" (e.g. a Stop that races behind a SessionEnd) must not downgrade it
 * back, and `forced` only ever turns on.
 */
function mergeIntoQueued(
  database: Database,
  queued: { id: number; forced: number; kind: string },
  request: { kind: string; forced: boolean },
): void {
  const nextKind = queued.kind === "session_end" ? "session_end" : request.kind;
  if ((request.forced && queued.forced === 0) || nextKind !== queued.kind) {
    database
      .query("UPDATE w5_jobs SET forced = ?, kind = ? WHERE id = ?")
      .run(request.forced ? 1 : queued.forced, nextKind, queued.id);
  }
}

export function enqueueJob(database: Database, input: EnqueueJobInput): EnqueueJobResult {
  const now = input.now ?? new Date().toISOString();

  const kind = input.kind ?? "classify";

  const existingQueued = database
    .query("SELECT id, forced, kind FROM w5_jobs WHERE session_id = ? AND state = 'queued'")
    .get(input.sessionId) as { id: number; forced: number; kind: string } | null;

  if (existingQueued) {
    mergeIntoQueued(database, existingQueued, { kind, forced: input.forced });
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

/**
 * Claims the oldest queued job in ONE statement. A select followed by an update
 * lets two runners pick the same row: both then update it and both read back
 * the other's claim, so both would hold it. Here the write lock is taken before
 * the subquery runs, the row can only still be `queued` for one caller, and the
 * claim returned is the one this statement wrote.
 */
export function claimNextJob(database: Database, now?: string): Job | null {
  const claimedAt = now ?? new Date().toISOString();
  const row = database
    .query(
      `UPDATE w5_jobs SET state = 'running', claimed_at = ?, attempts = attempts + 1
        WHERE id = (SELECT id FROM w5_jobs WHERE state = 'queued' ORDER BY id ASC LIMIT 1)
          AND state = 'queued'
        RETURNING *`,
    )
    .get(claimedAt) as JobRow | null;
  return row ? toJob(row) : null;
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
 * the reason in `error`. A job inside its lease is never touched. A runner that
 * was only slow, not dead (a laptop asleep mid-classify), can still be working a
 * job reaped from under it, and `w5.lock` cannot rule that out, so ownership is
 * the claim: `holdsClaim` is checked in the transaction that applies a result,
 * and the reaped runner's late finish writes nothing.
 *
 * A requeued job whose session already has another queued row (a hook enqueued
 * one after the crash) is failed as superseded, its `kind` and `forced` merged
 * into that row by the rules `enqueueJob` uses, so a session never holds two.
 * A failed job's `finished_at` is its claim time, not the reap time, so a reap
 * does not move old failures into the recent window.
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
        `SELECT id, session_id, kind, forced, attempts, requested_at, claimed_at FROM w5_jobs
          WHERE state = 'running' AND COALESCE(claimed_at, requested_at) <= ?`,
      )
      .all(leaseEnds) as {
      id: number;
      session_id: string;
      kind: string;
      forced: number;
      attempts: number;
      requested_at: string;
      claimed_at: string | null;
    }[];

    const requeue = database.query(
      "UPDATE w5_jobs SET state = 'queued', claimed_at = NULL WHERE id = ?",
    );
    const fail = database.query(
      "UPDATE w5_jobs SET state = 'failed', finished_at = ?, error = ? WHERE id = ?",
    );
    let requeued = 0;
    let failed = 0;
    const queuedFor = database.query(
      "SELECT id, forced, kind FROM w5_jobs WHERE session_id = ? AND state = 'queued'",
    );
    for (const job of stale) {
      const finishedAt = job.claimed_at ?? job.requested_at;
      if (job.attempts >= maxAttempts) {
        fail.run(
          finishedAt,
          `lease expired: the runner never finished this job in ${job.attempts} attempts`,
          job.id,
        );
        failed += 1;
      } else if (job.requested_at < oldestRequeued) {
        fail.run(
          finishedAt,
          `lease expired: the runner never finished this job and it is too old to classify live; tempad w5 backfill covers its session`,
          job.id,
        );
        failed += 1;
      } else {
        const queued = queuedFor.get(job.session_id) as {
          id: number;
          forced: number;
          kind: string;
        } | null;
        if (queued) {
          mergeIntoQueued(database, queued, { kind: job.kind, forced: job.forced === 1 });
          fail.run(
            finishedAt,
            `lease expired: superseded by queued job ${queued.id} for the same session`,
            job.id,
          );
          failed += 1;
        } else {
          requeue.run(job.id);
          requeued += 1;
        }
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

/**
 * True while `claim` is still the claim on a running job: the job was not
 * reaped and re-claimed (a different `claimed_at` or `attempts`) and not
 * settled by anyone else.
 */
export function holdsClaim(database: Database, id: number, claim: JobClaim): boolean {
  return (
    database
      .query(
        "SELECT 1 FROM w5_jobs WHERE id = ? AND state = 'running' AND claimed_at = ? AND attempts = ?",
      )
      .get(id, claim.claimedAt, claim.attempts) !== null
  );
}

/**
 * Marks the job done. `finishedAt` is when the work actually ended (default: the
 * wall clock now); `now` is the run's own timestamp and only feeds
 * `w5_runs.last_run_at`, which throttling measures from the start of the run.
 * Using `now` for `finished_at` made every done job's duration zero. With a `claim`, the update itself requires the caller to
 * still hold it (the same test as `holdsClaim`, in the one statement, so nothing
 * can change between check and write) and nothing is written otherwise; callers
 * that applied a result do both in one transaction, so a reaped runner discards
 * the result too. Returns whether the job was settled.
 */
export function completeJob(
  database: Database,
  id: number,
  lastMessageTs: string | null,
  now?: string,
  sessionNote?: string | null,
  claim?: JobClaim,
  finishedAt: string = new Date().toISOString(),
): boolean {
  const runAt = now ?? finishedAt;
  const settle = database.transaction((): boolean => {
    const job = database.query("SELECT session_id FROM w5_jobs WHERE id = ?").get(id) as {
      session_id: string;
    } | null;
    if (!job) return false;

    const settled = claim
      ? database
          .query(
            `UPDATE w5_jobs SET state = 'done', finished_at = ?
              WHERE id = ? AND state = 'running' AND claimed_at = ? AND attempts = ?`,
          )
          .run(finishedAt, id, claim.claimedAt, claim.attempts)
      : database
          .query("UPDATE w5_jobs SET state = 'done', finished_at = ? WHERE id = ?")
          .run(finishedAt, id);
    if (settled.changes !== 1) return false;

    database
      .query(
        `INSERT INTO w5_runs (session_id, last_run_at, last_message_ts, session_note) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET last_run_at = excluded.last_run_at,
                                               last_message_ts = excluded.last_message_ts,
                                               session_note = excluded.session_note`,
      )
      .run(job.session_id, runAt, lastMessageTs, sessionNote ?? null);
    return true;
  });
  return settle();
}

/**
 * Marks the job failed at `now` (default: the wall clock); with a `claim`, only
 * while the caller still holds it (one statement).
 */
export function failJob(
  database: Database,
  id: number,
  error: string,
  claim?: JobClaim,
  now: string = new Date().toISOString(),
): boolean {
  const result = claim
    ? database
        .query(
          `UPDATE w5_jobs SET state = 'failed', finished_at = ?, error = ?
            WHERE id = ? AND state = 'running' AND claimed_at = ? AND attempts = ?`,
        )
        .run(now, error, id, claim.claimedAt, claim.attempts)
    : database
        .query("UPDATE w5_jobs SET state = 'failed', finished_at = ?, error = ? WHERE id = ?")
        .run(now, error, id);
  return result.changes === 1;
}
