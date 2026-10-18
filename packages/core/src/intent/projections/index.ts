import type { Database } from "bun:sqlite";
import type { EventRecord } from "../events";
import { EventStore } from "../store";

export interface Projection {
  name: string;
  tables: string[];
  createSql: string;
  apply(database: Database, event: EventRecord): void;
  /**
   * Runs inside the rebuild's transaction after the event replay, for the
   * projections that derive rows from collected facts as well as events (the
   * session-kind rules): `tempad rebuild` restores their rows without a pass
   * or a model call. Must not depend on tables other projections own.
   */
  afterRebuild?: (database: Database) => void;
}

const registry = new Map<string, Projection>();

export function registerProjection(projection: Projection): void {
  registry.set(projection.name, projection);
}

export function listProjections(): Projection[] {
  return [...registry.values()];
}

export function ensureTables(database: Database): void {
  for (const projection of registry.values()) database.exec(projection.createSql);
}

export function applyIncremental(database: Database, event: EventRecord): void {
  ensureTables(database);
  const run = database.transaction(() => {
    for (const projection of registry.values()) {
      projection.apply(database, event);
      database
        .query(
          "INSERT INTO projection_state (name, last_event_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_event_id = excluded.last_event_id",
        )
        .run(projection.name, event.id);
    }
  });
  run();
}

export interface RebuildOptions {
  /** Replay only events with `at <= until` (time travel; see `stateAsOf`). */
  until?: string;
  /**
   * `beforeCommit(database)` runs inside the rebuild's IMMEDIATE transaction,
   * after every projection has been cleared and replayed and just before the
   * commit. Whatever it writes commits atomically with the rebuilt
   * projections, and a throw rolls the whole rebuild back. Push sync uses it
   * to clear its rebuild-pending marker in `sync_meta`, so the marker can
   * never be cleared by a rebuild that did not commit, nor survive one that
   * did.
   */
  beforeCommit?: (database: Database) => void;
}

/**
 * Truncates every projection and replays the event log into it.
 *
 * The events are read inside the same IMMEDIATE transaction that clears and
 * replays. Reading them first and only then taking the write lock left a
 * window in which another connection (a pull applying remote events, the w5
 * runner) could commit an event the replay never saw, yet `projection_state`
 * would still be stamped as complete. Holding the write lock across the read
 * means no event can land between the read and the commit.
 */
export function rebuildAll(database: Database, options: RebuildOptions = {}): void {
  ensureTables(database);
  const store = new EventStore(database);
  const run = database.transaction(() => {
    const events = store.read({ until: options.until });
    for (const projection of registry.values()) {
      for (const table of projection.tables) database.exec(`DELETE FROM ${table}`);
      for (const event of events) projection.apply(database, event);
      const last = events.at(-1)?.id ?? 0;
      database
        .query(
          "INSERT INTO projection_state (name, last_event_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_event_id = excluded.last_event_id",
        )
        .run(projection.name, last);
    }
    for (const projection of registry.values()) projection.afterRebuild?.(database);
    options.beforeCommit?.(database);
  });
  run.immediate();
}
