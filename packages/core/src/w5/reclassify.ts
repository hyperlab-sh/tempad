import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { HomeConfig } from "../config/env";
import type { W5Config } from "../intent/config";
import { hasAnyDeclaration } from "../intent/declarations";
import { type BackfillResult, backfill, type SessionRow, selectBackfillSessions } from "./backfill";
import type { Classifier } from "./classifier";
import { applyReset, planReset, type ResetPlan, type ResetResult, type ResetTrace } from "./reset";

/** Events written by w5 itself. Anything else on a row's history is a person's or another tool's. */
const W5_ACTORS = ["hook", "backfill", "system"] as const;

export const RECLASSIFY_REASON = "reclassify";

/** Why a session in the range is left exactly as it is. */
export type ProtectionReason =
  | "still active"
  | "declared"
  | "on a confirmed quest"
  | "on a quest a person changed"
  | "answered or assigned by a person"
  | "not written by w5";

export interface ProtectedSession {
  sessionId: string;
  reason: ProtectionReason;
}

export interface ReclassifyPlan {
  /** Sessions that will be reset and classified again, oldest first. */
  sessions: SessionRow[];
  /** Sessions in the range that are skipped entirely, reset and re-classification both. */
  protectedSessions: ProtectedSession[];
  reset: ResetPlan;
}

export interface ReclassifyRange {
  /** Lower bound on `claude_sessions.ended_at`, as `w5 backfill --from`. */
  from: string;
  /** Exclusive upper bound; when unset every later session is in range. */
  to?: string;
  hostSlug?: string;
  /** The instant "still active" is judged against. */
  now: string;
  /**
   * A session that ended less than this many minutes before `now` is still active:
   * the live runner closes a stint only after `[w5].stint_idle_minutes` without a
   * trace, so within that time its hook may classify the session's next window.
   */
  activeMinutes: number;
}

/**
 * Whether anything in `ids` carries an event whose actor satisfies `condition`
 * (SQL on `events.actor`). `ids` travel as one JSON array, so a session with
 * thousands of traces is still a single statement.
 */
function hasEventBy(database: Database, ids: string[], condition: string): boolean {
  if (ids.length === 0) return false;
  return (
    database
      .query(
        `SELECT 1 FROM events
          WHERE subject IN (SELECT value FROM json_each(?)) AND ${condition}
          LIMIT 1`,
      )
      .get(JSON.stringify(ids)) !== null
  );
}

/**
 * Why a session must not be reclassified, or null when everything w5 holds for it
 * is w5's own inference.
 *
 * - **still active**: it ended within `activeMinutes` of now, so the live runner
 *   (which does not wait for this command) may be classifying it, and both would
 *   write the same window.
 * - **declared**: any `quest.declared` for the session. Its traces were verified
 *   against what the person declared, and re-running it would put them in the
 *   "nothing declared yet" path.
 * - **on a confirmed quest** / **on a quest a person changed**: one of its stints
 *   sits on a quest a person confirmed (declared quests are confirmed) or that
 *   anything but w5 ever touched. Retracting the stint would leave the quest
 *   without the attribution the person validated, and the classifier need not
 *   attach the new stint to it.
 * - **answered or assigned by a person**: a `hero` event on one of its traces,
 *   stints or questions (`tempad answer`, a manual quest assignment, a reword).
 * - **not written by w5**: a live trace that no w5 actor recorded.
 *
 * A session is protected whole rather than row by row: classification works on
 * whole windows, so keeping one trace of a window and redoing the rest would
 * leave the window covered twice.
 */
function protectionFor(
  database: Database,
  session: SessionRow,
  traces: ResetTrace[],
  range: ReclassifyRange,
  w5Only: (questId: string) => boolean,
): ProtectionReason | null {
  const sessionId = session.id;
  if (Date.parse(range.now) - Date.parse(session.ended_at) < range.activeMinutes * 60_000) {
    return "still active";
  }
  if (hasAnyDeclaration(database, sessionId)) return "declared";

  const questRows =
    traces.length === 0
      ? []
      : (database
          .query(
            `SELECT DISTINCT quests.id AS id, quests.confirmed AS confirmed FROM stints
               JOIN quests ON quests.id = stints.quest_id AND quests.retracted_at IS NULL
              WHERE stints.id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify([...new Set(traces.map((trace) => trace.stint_id))])) as {
          id: string;
          confirmed: number;
        }[]);
  if (questRows.some((quest) => quest.confirmed === 1)) return "on a confirmed quest";
  if (questRows.some((quest) => !w5Only(quest.id))) return "on a quest a person changed";

  const traceIds = traces.map((trace) => trace.id);
  const w5Actors = W5_ACTORS.map((actor) => `'${actor}'`).join(", ");
  if (
    traceIds.length > 0 &&
    database
      .query(
        `SELECT 1 FROM traces
          WHERE id IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (SELECT 1 FROM events
                             WHERE events.subject = traces.id AND events.kind = 'trace.recorded'
                               AND events.actor IN (${w5Actors}))
          LIMIT 1`,
      )
      .get(JSON.stringify(traceIds)) !== null
  ) {
    return "not written by w5";
  }
  const stintIds = [...new Set(traces.map((trace) => trace.stint_id))];
  const questionIds =
    traceIds.length === 0
      ? []
      : (
          database
            .query("SELECT id FROM questions WHERE trace_id IN (SELECT value FROM json_each(?))")
            .all(JSON.stringify(traceIds)) as { id: string }[]
        ).map((row) => row.id);
  if (hasEventBy(database, [...traceIds, ...stintIds, ...questionIds], "actor = 'hero'")) {
    return "answered or assigned by a person";
  }

  return null;
}

/**
 * What `reclassify` would do, writing nothing. The sessions are the ones
 * `w5 backfill --from/--to` selects, so the range means the same in both; for
 * each, every live trace is a candidate (not only those after `from`, since a
 * session is classified from its first message) unless the session is protected.
 * Unconfirmed quests are retracted only when w5 alone ever touched them.
 */
export function planReclassify(database: Database, range: ReclassifyRange): ReclassifyPlan {
  const selected = selectBackfillSessions(database, {
    cutoff: range.from,
    to: range.to,
    hostSlug: range.hostSlug,
  });

  const w5Only = (questId: string): boolean =>
    !hasEventBy(database, [questId], `actor NOT IN (${W5_ACTORS.map((a) => `'${a}'`).join(", ")})`);

  const sessions: SessionRow[] = [];
  const protectedSessions: ProtectedSession[] = [];
  const traces: ResetTrace[] = [];
  for (const session of selected) {
    // Every live trace: the session ended before `to`, so none of them can start after it.
    const sessionTraces = database
      .query(
        "SELECT id, stint_id, session_id FROM traces WHERE session_id = ? AND retracted_at IS NULL",
      )
      .all(session.id) as ResetTrace[];
    const reason = protectionFor(database, session, sessionTraces, range, w5Only);
    if (reason !== null) {
      protectedSessions.push({ sessionId: session.id, reason });
      continue;
    }
    sessions.push(session);
    traces.push(...sessionTraces);
  }

  return {
    sessions,
    protectedSessions,
    reset: planReset(database, traces, { mayRetractQuest: w5Only }),
  };
}

export interface ReclassifyOptions extends ReclassifyRange {
  log: (line: string) => void;
}

export interface ReclassifyResult {
  plan: ReclassifyPlan;
  reset: ResetResult;
  backfill: BackfillResult;
}

/**
 * Retracts w5's inferred traces, stints and quests for the sessions in range (as
 * `retracted` events, never a delete: history stays, reports and the classifier's
 * memory slice skip retracted rows) and classifies those sessions again from their
 * first message with `force` (which ignores `w5_windows` coverage, so the old rows
 * stay: they are a projection of events and deleting them would not survive a
 * rebuild). A window that fails is not retried by a plain backfill, which sees it
 * as covered; run the same `--reclassify` again, it resets and classifies afresh. Protected sessions are left alone by both steps,
 * `backfill` being told which sessions it may touch.
 */
export async function reclassify(
  database: Database,
  config: HomeConfig,
  intentConfig: W5Config,
  classifier: Classifier,
  options: ReclassifyOptions,
): Promise<ReclassifyResult> {
  const plan = planReclassify(database, options);
  const reset = applyReset(database, plan.reset, {
    reason: RECLASSIFY_REASON,
    clearWindowCoverage: false,
  });
  options.log(
    `reclassify: retracted traces=${reset.traces} stints=${reset.stints} quests=${reset.quests}, closed questions=${reset.questions} continuations=${reset.continuations}`,
  );

  const result = await backfill(database, config, intentConfig, classifier, {
    days: 0,
    now: options.now,
    log: options.log,
    force: true,
    from: options.from,
    ...(options.to !== undefined ? { to: options.to } : {}),
    ...(options.hostSlug !== undefined ? { hostSlug: options.hostSlug } : {}),
    sessionIds: new Set(plan.sessions.map((session) => session.id)),
  });
  return { plan, reset, backfill: result };
}

export class BackupError extends Error {}

/**
 * A consistent copy of the open database at `destination` through SQLite's own
 * `VACUUM INTO` (a file copy of a WAL database can miss committed rows), checked
 * by reading it back: the same number of events, which every write appends to.
 * Refuses to overwrite a file.
 */
export function backupDatabase(database: Database, destination: string): void {
  if (existsSync(destination)) throw new BackupError(`${destination} already exists`);
  database.exec("VACUUM INTO ?", [destination]);
  const copy = new Database(destination, { readonly: true });
  try {
    const count = (db: Database) =>
      (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    if (count(copy) !== count(database)) {
      throw new BackupError(`${destination} does not hold every event of the database`);
    }
  } finally {
    copy.close();
  }
}
