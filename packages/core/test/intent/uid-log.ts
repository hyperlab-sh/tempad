import type { Database } from "bun:sqlite";
import { encodeTime } from "ulid";
import { openDatabase } from "../../src/db/database";
import { applyIncremental, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";

registerAllProjections();

/** One logged event as another host's pull would hand it over: uid and host included. */
export interface LoggedEvent {
  /** Position on a shared timeline, in seconds. Lower sorts (and replays) first. */
  second: number;
  host: string;
  kind: string;
  subject: string;
  payload: object;
}

const BASE = Date.parse("2026-09-01T10:00:00.000Z");

export function uidFor(second: number, tiebreak = 0): string {
  return `${encodeTime(BASE + second * 1000, 10)}${tiebreak.toString().padStart(16, "0")}`;
}

/**
 * A database holding exactly `events`, inserted in reverse uid order (so local
 * ids disagree with uid order, as a pull leaves them) and rebuilt.
 */
export function databaseFrom(events: LoggedEvent[]): Database {
  const database = openDatabase(":memory:");
  insertEvents(database, events);
  rebuildAll(database);
  return database;
}

export function insertEvents(database: Database, events: LoggedEvent[]): void {
  const insert = database.query(
    `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload, uid, sync_host, sync_dirty)
     VALUES (?, ?, 'hero', NULL, ?, ?, ?, ?, ?, 0)`,
  );
  const ordered = events.map((event, index) => ({ event, uid: uidFor(event.second, index) }));
  for (const { event, uid } of [...ordered].reverse()) {
    const at = new Date(BASE + event.second * 1000).toISOString();
    insert.run(at, at, event.kind, event.subject, JSON.stringify(event.payload), uid, event.host);
  }
}

/** Replays `events` one by one through the incremental path, in uid order. */
export function databaseFromIncremental(events: LoggedEvent[]): Database {
  const database = openDatabase(":memory:");
  const store = new EventStore(database);
  for (const event of [...events].sort((a, b) => a.second - b.second)) {
    const at = new Date(BASE + event.second * 1000).toISOString();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        at,
        kind: event.kind as never,
        subject: event.subject,
        payload: event.payload as Record<string, unknown>,
      }),
    );
  }
  return database;
}
