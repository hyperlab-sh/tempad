/**
 * `tempad sync --forget`: the off switch for a host that leaves sync for good
 * (docs/specs/push-sync.md, "Trigger gate"). Local only, no network.
 *
 * The `mirror_sync_enabled` marker is sticky on purpose, so removing `[sync]`
 * alone keeps stamping rows and keeping tombstones for a remote that may come
 * back. This is the explicit way to say it will not: in one `IMMEDIATE`
 * transaction it deletes the marker, every key that ties the database to one
 * remote (`REMOTE_BOUND_META_KEYS`) and the pull cursors, then hands the rest
 * to `reconcileMirrorTriggers`, which with the marker gone drops the 18 mirror
 * triggers and every tombstone. The `sync_*` stamp columns and `sync_dirty`
 * flags stay as they are: nothing reads them without the triggers, and
 * `enableMirrorSync` restamps every row if sync is ever turned on again.
 */
import type { Database } from "bun:sqlite";
import {
  defaultRebuild,
  FORGOTTEN_SERVER_ID,
  REMOTE_BOUND_META_KEYS,
  rebuildIfPending,
  type SyncRunOptions,
} from "./engine";
import { SYNCED_APPEND_TABLES, SYNCED_UPSERT_TABLES } from "./tables";
import {
  isMirrorSyncEnabled,
  MIRROR_SYNC_ENABLED,
  MIRROR_TRIGGER_NAMES,
  reconcileMirrorTriggers,
} from "./triggers";

export interface ForgetSummary {
  triggersDropped: number;
  tombstonesDeleted: number;
  cursorsCleared: number;
  /** Marker and remote-bound `sync_meta` keys deleted. */
  metaKeysDeleted: string[];
}

/** Rows and tombstones that never reached the server, so a forget would drop them for good. */
export class UnpushedChangesError extends Error {
  constructor(
    readonly deletes: number,
    readonly changes: number,
  ) {
    super(
      `${deletes} deletes / ${changes} changes never reached the server; ` +
        "re-enable [sync] and run `tempad sync --push` first, or pass --force to leave them behind",
    );
  }
}

function count(database: Database, sql: string, args: string[] = []): number {
  return (database.query(sql).get(...args) as { n: number }).n;
}

/**
 * Returns what it removed, or `null` when sync was never enabled on this
 * database (nothing to forget). Pulled events not yet projected are projected
 * first (`rebuild_pending`), since nothing will do it once sync is off; a
 * failing rebuild throws and leaves everything untouched.
 *
 * Throws `UnpushedChangesError`, changing nothing, when a tombstone, event or
 * mirror row is still `sync_dirty` and `force` is not set: the forget would
 * delete the tombstones and no later run could push the rest. The id of the
 * server this database was tied to is kept as `FORGOTTEN_SERVER_ID`, so a later
 * run refuses to rejoin it (see `ForgottenServerError`).
 */
export function forgetSync(
  database: Database,
  rebuild: NonNullable<SyncRunOptions["rebuildProjections"]> = defaultRebuild,
  force = false,
): ForgetSummary | null {
  rebuildIfPending(database, rebuild);
  return database
    .transaction((): ForgetSummary | null => {
      const metaKeys = [MIRROR_SYNC_ENABLED, ...REMOTE_BOUND_META_KEYS];
      const placeholders = metaKeys.map(() => "?").join(", ");
      const present = (
        database
          .query(`SELECT key FROM sync_meta WHERE key IN (${placeholders})`)
          .all(...metaKeys) as { key: string }[]
      ).map((row) => row.key);
      const triggersDropped = count(
        database,
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${MIRROR_TRIGGER_NAMES.map(() => "?").join(", ")})`,
        [...MIRROR_TRIGGER_NAMES],
      );
      const tombstonesDeleted = count(database, "SELECT COUNT(*) AS n FROM sync_tombstones");
      const cursorsCleared = count(database, "SELECT COUNT(*) AS n FROM sync_cursors");
      if (
        !isMirrorSyncEnabled(database) &&
        present.length === 0 &&
        triggersDropped === 0 &&
        tombstonesDeleted === 0 &&
        cursorsCleared === 0
      ) {
        return null;
      }
      if (!force) {
        const deletes = count(
          database,
          "SELECT COUNT(*) AS n FROM sync_tombstones WHERE sync_dirty = 1",
        );
        let changes = 0;
        for (const table of [...SYNCED_APPEND_TABLES, ...SYNCED_UPSERT_TABLES]) {
          changes += count(
            database,
            `SELECT COUNT(*) AS n FROM ${table.name} WHERE sync_dirty = 1`,
          );
        }
        if (deletes + changes > 0) throw new UnpushedChangesError(deletes, changes);
      }
      // The server this database was tied to: the stored id, else the one a
      // re-seed in flight was started against. Never overwritten with nothing.
      const serverId = (
        database
          .query(
            "SELECT value FROM sync_meta WHERE key IN ('reseed_pending', 'server_id') ORDER BY key = 'reseed_pending' DESC LIMIT 1",
          )
          .get() as { value: string } | null
      )?.value;
      database.query(`DELETE FROM sync_meta WHERE key IN (${placeholders})`).run(...metaKeys);
      if (serverId !== undefined) {
        database
          .query(
            "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          )
          .run(FORGOTTEN_SERVER_ID, serverId);
      }
      database.exec("DELETE FROM sync_cursors");
      // With the marker gone this drops the triggers and prunes the tombstones.
      reconcileMirrorTriggers(database);
      return { triggersDropped, tombstonesDeleted, cursorsCleared, metaKeysDeleted: present };
    })
    .immediate();
}

export function formatForgetSummary(summary: ForgetSummary | null): string {
  if (summary === null) return "sync: nothing to forget";
  return `sync: forgot triggers=${summary.triggersDropped} tombstones=${summary.tombstonesDeleted} cursors=${summary.cursorsCleared} meta=${summary.metaKeysDeleted.length}`;
}
