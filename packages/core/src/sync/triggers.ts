/**
 * The push-sync trigger gate (docs/specs/push-sync.md, "Trigger gate").
 *
 * The 18 mirror triggers (`<mirror>_sync_insert|update|delete`, defined in
 * `mirror-triggers.sql`) exist only on a database where sync has been used:
 * the `mirror_sync_enabled` key in `sync_meta` marks it, and
 * `reconcileMirrorTriggers` makes the installed triggers match the marker.
 * A host without `[sync]` therefore stamps nothing, tombstones nothing and
 * pays no per-row trigger cost: even a trigger whose `WHEN` is a constant
 * false costs about half of the full trigger on a 20000-row insert, because
 * SQLite still materializes the OLD/NEW row for every AFTER trigger it finds.
 *
 * The marker is sticky. Once a sync has run, turning `[sync]` off later does
 * not drop the triggers or the tombstones: the remote still holds this host's
 * rows, and a delete made while sync was paused must reach it when sync comes
 * back.
 *
 * No network code lives here: `openDatabase` imports it on every open.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SYNCED_UPSERT_TABLES } from "./tables";

/** `sync_meta` key whose presence installs the mirror triggers. Local-only. */
export const MIRROR_SYNC_ENABLED = "mirror_sync_enabled";

const TRIGGER_SUFFIXES = ["insert", "update", "delete"] as const;

/** Every mirror trigger name, `<mirror>_sync_<insert|update|delete>`. */
export const MIRROR_TRIGGER_NAMES: readonly string[] = SYNCED_UPSERT_TABLES.flatMap((table) =>
  TRIGGER_SUFFIXES.map((suffix) => `${table.name}_sync_${suffix}`),
);

let cachedDefinitions: Map<string, string> | undefined;

/**
 * Trigger name -> `CREATE TRIGGER ... END` text, read from
 * `mirror-triggers.sql`. The text is exactly what SQLite stores in
 * `sqlite_master.sql` for it (the statement without its final semicolon), so
 * an installed trigger can be compared with its definition as a string.
 */
export function mirrorTriggerDefinitions(): Map<string, string> {
  if (cachedDefinitions !== undefined) return cachedDefinitions;
  const source = readFileSync(join(import.meta.dir, "mirror-triggers.sql"), "utf8");
  const definitions = new Map<string, string>();
  for (const chunk of source.split(/^END;$/m)) {
    const lines = chunk.split("\n");
    const start = lines.findIndex((line) => line.startsWith("CREATE TRIGGER "));
    if (start === -1) continue;
    const sql = `${lines.slice(start).join("\n")}END`;
    const name = sql.match(/^CREATE TRIGGER (\S+)/)?.[1];
    if (name === undefined) throw new Error("mirror-triggers.sql: a trigger has no name");
    definitions.set(name, sql);
  }
  const expected = [...MIRROR_TRIGGER_NAMES].sort();
  const found = [...definitions.keys()].sort();
  if (JSON.stringify(expected) !== JSON.stringify(found)) {
    throw new Error(
      `mirror-triggers.sql defines ${found.join(", ")}; expected ${expected.join(", ")}`,
    );
  }
  cachedDefinitions = definitions;
  return definitions;
}

function hasSyncMeta(database: Database): boolean {
  return (
    database
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_meta'")
      .get() !== null
  );
}

/** Whether sync has ever run on this database (the sticky marker is set). */
export function isMirrorSyncEnabled(database: Database): boolean {
  return (
    hasSyncMeta(database) &&
    database.query("SELECT 1 FROM sync_meta WHERE key = ?").get(MIRROR_SYNC_ENABLED) !== null
  );
}

interface TriggerPlan {
  drop: string[];
  create: string[];
  pruneTombstones: boolean;
}

/** What it takes to make the installed triggers match the marker; read-only. */
function planTriggers(database: Database): TriggerPlan {
  const enabled = isMirrorSyncEnabled(database);
  const installed = new Map(
    (
      database
        .query(
          `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${MIRROR_TRIGGER_NAMES.map(() => "?").join(", ")})`,
        )
        .all(...MIRROR_TRIGGER_NAMES) as { name: string; sql: string }[]
    ).map((row) => [row.name, row.sql]),
  );
  if (!enabled) {
    // No remote has ever seen this database's rows, so no tombstone has a
    // reader. Only rows left by 0019's unconditional triggers can be here.
    const tombstones = database.query("SELECT 1 FROM sync_tombstones LIMIT 1").get() !== null;
    return { drop: [...installed.keys()], create: [], pruneTombstones: tombstones };
  }
  const definitions = mirrorTriggerDefinitions();
  const drop: string[] = [];
  const create: string[] = [];
  for (const [name, sql] of definitions) {
    const current = installed.get(name);
    if (current === sql) continue;
    if (current !== undefined) drop.push(name);
    create.push(sql);
  }
  return { drop, create, pruneTombstones: false };
}

function applyPlan(database: Database, plan: TriggerPlan): void {
  for (const name of plan.drop) database.exec(`DROP TRIGGER IF EXISTS ${name}`);
  for (const sql of plan.create) database.exec(sql);
  if (plan.pruneTombstones) database.exec("DELETE FROM sync_tombstones");
}

function isEmpty(plan: TriggerPlan): boolean {
  return plan.drop.length === 0 && plan.create.length === 0 && !plan.pruneTombstones;
}

/**
 * Makes the installed mirror triggers match the marker: all 18, with the
 * text of `mirror-triggers.sql`, when sync is enabled; none, and no
 * tombstones, when it is not. The caller holds the write transaction
 * (a migration, `enableMirrorSync`).
 */
export function reconcileMirrorTriggers(database: Database): void {
  if (!hasSyncMeta(database)) return;
  applyPlan(database, planTriggers(database));
}

/**
 * `reconcileMirrorTriggers` for `openDatabase`: a read-only check first, so
 * the common open (nothing to change) never takes the write lock, then the
 * change under an IMMEDIATE transaction, re-planned under the lock in case
 * another process got there first.
 */
export function ensureMirrorTriggers(database: Database): void {
  if (!hasSyncMeta(database)) return;
  if (isEmpty(planTriggers(database))) return;
  database.transaction(() => applyPlan(database, planTriggers(database))).immediate();
}

/**
 * Restamps every row of one mirror as a write made now, the way the update
 * trigger would: `MAX(now, old stamp + 1 ms)`, so a stamp never moves
 * backwards, with `sync_host` = the local host and `sync_dirty = 1`.
 */
const MIRROR_BACKFILL = (table: string) =>
  `UPDATE ${table}
      SET sync_updated_at = MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', sync_updated_at, '+0.001 seconds'), '')),
          sync_host = COALESCE((SELECT host_slug FROM sync_local WHERE id = 1), sync_host),
          sync_dirty = 1`;

/**
 * Turns sync on for this database, once: in one IMMEDIATE transaction, sets
 * the marker, restamps every mirror row as written now (`MIRROR_BACKFILL`),
 * and installs the triggers. Returns whether this call did it; later calls
 * are a read and a no-op.
 *
 * Every row is restamped, not only those with no stamp. The marker is absent,
 * so nothing on this host was ever pushed and every row is already dirty. But
 * a row 0019 stamped (say Sept 1) and a collector changed while the triggers
 * were absent (Oct 5) still carries the Sept 1 stamp, so on the first pull it
 * would lose last-writer-wins to an older version another host pushed on
 * Oct 1. Rows written while sync was off therefore count as written at enable
 * time; `tempad sync` collects before it pushes, so they are fresh then.
 *
 * Rows deleted while sync was off get no tombstone: no remote has ever held
 * this database's rows, so there is nothing to delete remotely.
 */
export function enableMirrorSync(database: Database): boolean {
  if (isMirrorSyncEnabled(database)) return false;
  return database
    .transaction(() => {
      if (isMirrorSyncEnabled(database)) return false;
      database
        .query(
          "INSERT INTO sync_meta (key, value) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .run(MIRROR_SYNC_ENABLED);
      for (const table of SYNCED_UPSERT_TABLES) database.exec(MIRROR_BACKFILL(table.name));
      reconcileMirrorTriggers(database);
      return true;
    })
    .immediate();
}
