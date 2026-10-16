import type { Database } from "bun:sqlite";
import { openDatabase } from "../db/database";
import { rebuildAll } from "./projections";
import { EventStore } from "./store";

/**
 * Rebuilds projections into a fresh in-memory database from the events up to
 * `until`. Each event is copied with its `uid`, `sync_host` and `sync_dirty`,
 * so the copy replays in exactly the source's `ORDER BY uid` order.
 */
export function stateAsOf(database: Database, until: string): Database {
  const target = openDatabase(":memory:");
  const store = new EventStore(database);
  const events = store.read({ until });
  const insert = target.query(
    `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload, uid, sync_host, sync_dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAll = target.transaction(() => {
    for (const event of events) {
      insert.run(
        event.at,
        event.recordedAt,
        event.actor,
        event.sessionId,
        event.kind,
        event.subject,
        JSON.stringify(event.payload),
        event.uid,
        event.syncHost,
        event.syncDirty ? 1 : 0,
      );
    }
  });
  insertAll();
  rebuildAll(target, { until });
  return target;
}
