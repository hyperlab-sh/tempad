import type { Database } from "bun:sqlite";
import { openDatabase } from "../db/database";
import { rebuildAll } from "./projections";
import { EventStore } from "./store";

/**
 * The collector-fact tables a projection's `afterRebuild` pass reads (the
 * session-kind rules, `src/intent/projections/session-kind.ts`). The replay
 * target gets the same facts the source holds, so a rule row computed by a
 * real rebuild is reproduced exactly (`compareProjectionsToReplay`) instead of
 * appearing as an extra the comparison can never clear.
 */
const FACT_TABLES = ["claude_sessions", "claude_messages"] as const;

function copyFacts(source: Database, target: Database): void {
  for (const table of FACT_TABLES) {
    if (
      source.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) ===
      null
    ) {
      continue;
    }
    const columns = (
      source.query("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(table) as {
        name: string;
      }[]
    ).map((row) => row.name);
    if (columns.length === 0) continue;
    const list = columns.map((column) => `"${column}"`).join(", ");
    const rows = source.query(`SELECT ${list} FROM "${table}"`).values();
    const insert = target.query(
      `INSERT INTO "${table}" (${list}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    const run = target.transaction(() => {
      for (const row of rows) insert.run(...(row as (string | number | null)[]));
    });
    run();
  }
}

/**
 * Rebuilds projections into a fresh in-memory database from the events up to
 * `until`. Each event is copied with its `uid`, `sync_host` and `sync_dirty`,
 * so the copy replays in exactly the source's `ORDER BY uid` order. The
 * collected session/message facts are copied too, so projections that derive
 * rows from them (the session-kind rules) replay what the source holds.
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
  copyFacts(database, target);
  rebuildAll(target, { until });
  return target;
}
