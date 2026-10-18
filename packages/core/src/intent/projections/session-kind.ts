import type { Projection } from "./index";

/**
 * A `session.kind_set` event records the kind a person gave a Claude session by
 * hand (`tempad sessions kind <id> --set <kind>`). It is a human decision, so
 * unlike the inferred kinds in `session_kind` (a cache the sync pass refills) it
 * is an event, survives `tempad rebuild` and wins over inference. The latest
 * event for a session is the one that counts; a `kind` of null (`--clear`) hands
 * the session back to inference.
 */
export const sessionKindProjection: Projection = {
  name: "session_kind_overrides",
  tables: ["session_kind_overrides"],
  createSql: `
    CREATE TABLE IF NOT EXISTS session_kind_overrides (
      session_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      set_at TEXT NOT NULL
    );`,
  apply(database, event) {
    if (event.kind !== "session.kind_set") return;
    const kind = event.payload.kind;
    if (typeof kind !== "string") {
      database.query("DELETE FROM session_kind_overrides WHERE session_id = ?").run(event.subject);
      return;
    }
    database
      .query(
        `INSERT INTO session_kind_overrides (session_id, kind, set_at) VALUES (?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET kind = excluded.kind, set_at = excluded.set_at`,
      )
      .run(event.subject, kind, event.at);
  },
};
