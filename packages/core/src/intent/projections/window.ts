import type { Projection } from "./index";

/**
 * A `window.classified` event records that a backfill window (a chunk of a
 * Claude session's messages, see `chunkByWindow` in `src/w5/backfill.ts`)
 * was successfully classified and applied -- independent of how many trace
 * segments the classifier split it into. `planBackfillWindows` checks this
 * table instead of `traces` so a window that produced 2+ segments (and
 * therefore 2+ traces, none of which individually span the window's exact
 * bounds) is still correctly recognized as already covered on the next run.
 */
export const windowProjection: Projection = {
  name: "w5_windows",
  tables: ["w5_windows"],
  createSql: `
    CREATE TABLE IF NOT EXISTS w5_windows (
      session_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      classified_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS w5_windows_session ON w5_windows(session_id, started_at, ended_at);`,
  apply(database, event) {
    if (event.kind !== "window.classified") return;
    const payload = event.payload;
    database
      .query(
        "INSERT INTO w5_windows (session_id, started_at, ended_at, classified_at) VALUES (?, ?, ?, ?)",
      )
      .run(String(payload.session), String(payload.startedAt), String(payload.endedAt), event.at);
  },
};
