import { type DeclarationRow, foldCoverage } from "../declarations";
import type { Projection } from "./index";

/**
 * A `window.classified` event records that a backfill window (a chunk of a
 * Claude session's messages, see `chunkByWindow` in `src/w5/backfill.ts`)
 * was successfully classified and applied -- independent of how many trace
 * segments the classifier split it into. `planBackfillWindows` checks this
 * table instead of `traces` so a window that produced 2+ segments (and
 * therefore 2+ traces, none of which individually span the window's exact
 * bounds) is still correctly recognized as already covered on the next run.
 *
 * `w5_stale_windows` is derived from `quest.declared` events, no event of its
 * own: a declaration whose coverage starts before the declaration itself (see
 * `activeDeclaredQuests`) makes every window classified before it stale for that
 * stretch, since those windows ran without the quest. `from_ts` is null for "the
 * session's start" (the session row is not read here: the projection must
 * rebuild the same wherever the transcript was collected), `through_ts` is the
 * declaration's `at`, and `marked_at` the moment it was recorded, which a window
 * classified later than that has already seen. `planBackfillWindows` reads it.
 */
export const windowProjection: Projection = {
  name: "w5_windows",
  tables: ["w5_windows", "w5_stale_windows"],
  createSql: `
    CREATE TABLE IF NOT EXISTS w5_windows (
      session_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      classified_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS w5_windows_session ON w5_windows(session_id, started_at, ended_at);
    CREATE TABLE IF NOT EXISTS w5_stale_windows (
      session_id TEXT NOT NULL,
      from_ts TEXT,
      through_ts TEXT NOT NULL,
      marked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS w5_stale_windows_session ON w5_stale_windows(session_id);`,
  apply(database, event) {
    if (event.kind === "quest.declared") {
      markStaleWindows(database, event);
      return;
    }
    if (event.kind !== "window.classified") return;
    const payload = event.payload;
    database
      .query(
        "INSERT INTO w5_windows (session_id, started_at, ended_at, classified_at) VALUES (?, ?, ?, ?)",
      )
      .run(String(payload.session), String(payload.startedAt), String(payload.endedAt), event.at);
  },
};

function markStaleWindows(
  database: Parameters<Projection["apply"]>[0],
  event: Parameters<Projection["apply"]>[1],
): void {
  const payload = event.payload as DeclarationRow["payload"] & {
    session_id?: string;
    scope?: string;
  };
  if (payload.done === true || !payload.session_id) return;
  const scope = payload.scope === "subagent" ? "subagent" : "session";
  // The fold is deterministic over the events up to this one (uid order is the
  // apply order; a record with no uid, as the pre-sync replay hands over, goes by
  // row id), so an incremental apply and a rebuild mark the same rows.
  const rows = (
    database
      .query(
        `SELECT payload, at, uid, id FROM events
          WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ?1
            AND json_extract(payload, '$.scope') = ?2
            AND (CASE WHEN ?3 IS NULL THEN id <= ?4 ELSE uid <= ?3 END)
          ORDER BY at ASC, uid ASC, id ASC`,
      )
      .all(payload.session_id, scope, event.uid, event.id) as {
      payload: string;
      at: string;
      uid: string | null;
      id: number;
    }[]
  )
    .map(
      (row) =>
        ({
          at: row.at,
          uid: row.uid,
          id: row.id,
          payload: JSON.parse(row.payload),
        }) as DeclarationRow,
    )
    .filter(
      (row) => scope !== "subagent" || row.payload.parent_session_id === payload.parent_session_id,
    );
  const interval = foldCoverage(rows).find((candidate) => candidate.declaredId === event.id);
  if (interval === undefined) return;
  if (interval.start !== null && interval.start >= interval.declaredAt) return;
  database
    .query(
      "INSERT INTO w5_stale_windows (session_id, from_ts, through_ts, marked_at) VALUES (?, ?, ?, ?)",
    )
    .run(payload.session_id, interval.start, interval.declaredAt, event.recordedAt);
}
