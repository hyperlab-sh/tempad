import { resolveOwnerIdentity } from "../identity";
import type { Projection } from "./index";

export const sagaProjection: Projection = {
  name: "sagas",
  tables: ["sagas"],
  createSql: `
    CREATE TABLE IF NOT EXISTS sagas (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      statement TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      replaced_by TEXT
    );`,
  apply(database, event) {
    const payload = event.payload;
    switch (event.kind) {
      case "saga.created": {
        const owner = resolveOwnerIdentity(database, payload.owner as { kind: string; id: string });
        database
          .query(
            "INSERT OR REPLACE INTO sagas (id, owner_kind, owner_id, title, statement, revision, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
          )
          .run(
            event.subject,
            owner.kind,
            owner.id,
            String(payload.title),
            payload.statement ? String(payload.statement) : null,
            event.at,
          );
        return;
      }
      case "saga.reworded":
        database
          .query(
            "UPDATE sagas SET title = COALESCE(?, title), statement = COALESCE(?, statement), revision = revision + 1 WHERE id = ?",
          )
          .run(
            payload.title !== undefined ? String(payload.title) : null,
            payload.statement !== undefined ? String(payload.statement) : null,
            event.subject,
          );
        return;
      case "saga.ended":
        database
          .query("UPDATE sagas SET ended_at = ?, end_reason = ?, replaced_by = ? WHERE id = ?")
          .run(
            event.at,
            payload.reason ? String(payload.reason) : null,
            payload.replaced_by ? String(payload.replaced_by) : null,
            event.subject,
          );
        return;
      default:
        return;
    }
  },
};
