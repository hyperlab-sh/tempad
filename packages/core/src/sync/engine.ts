/**
 * Push sync engine (docs/specs/push-sync.md, "Remote schema" through
 * "Failure and partial push"). Pure SQL against two databases: the local
 * `bun:sqlite` one and a remote reached through `SyncRemote`, a two-method
 * interface the real `@libsql/client` adapter (`remote.ts`) and the tests'
 * in-process SQLite fake both implement. Nothing here imports a network
 * module.
 */
import type { Database, Statement } from "bun:sqlite";
import { newUlid } from "../intent/ids";
import { type RebuildOptions, rebuildAll } from "../intent/projections";
import { registerAllProjections } from "../intent/projections/register";
import { MIRROR_SYNC_COLUMNS, SYNCED_UPSERT_TABLES, type SyncedUpsertTable } from "./tables";

export type SqlValue = string | number | bigint | null;

export interface RemoteStatement {
  sql: string;
  args: SqlValue[];
}

/** The remote side of sync: reads, and atomic multi-statement writes. */
export interface SyncRemote {
  query(sql: string, args?: SqlValue[]): Promise<Record<string, SqlValue>[]>;
  /** Runs every statement in one write transaction; all or nothing. */
  write(statements: RemoteStatement[]): Promise<void>;
  close(): void;
}

export interface SyncRunOptions {
  hostSlug: string;
  /** Rows per push batch (one remote transaction each). */
  batchSize: number;
  /** Remote rows per pull page; defaults to `batchSize`. */
  pageSize?: number;
  push: boolean;
  pull: boolean;
  /**
   * Rebuilds every projection; defaults to `registerAllProjections()` plus
   * `rebuildAll`. It must run `options.beforeCommit` inside the rebuild's
   * transaction (as `rebuildAll` does), which is where the pending marker
   * is cleared. Tests pass a failing one to prove the marker.
   */
  rebuildProjections?: (database: Database, options: RebuildOptions) => void;
  /** Non-fatal problems (a failed first rebuild); defaults to stderr. */
  warn?: (message: string) => void;
}

export interface SyncCounts {
  events: number;
  rows: number;
  tombstones: number;
}

export interface SyncRunSummary {
  pushed: SyncCounts;
  pulled: SyncCounts;
  rebuilt: boolean;
  /** True when the remote's identity was unknown and this run re-seeded it. */
  reseeded: boolean;
}

export class SchemaGateError extends Error {}

/** The remote schema: generic, never a copy of local DDL. */
export const REMOTE_SCHEMA: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT)",
  "CREATE TABLE IF NOT EXISTS sync_clock (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sync_rows (tbl TEXT, pk TEXT, data TEXT, sync_host TEXT NOT NULL, sync_updated_at TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (tbl, pk))",
  "CREATE TABLE IF NOT EXISTS sync_events (uid TEXT PRIMARY KEY, data TEXT NOT NULL, sync_host TEXT NOT NULL, seq INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS sync_rows_seq ON sync_rows(seq)",
  "CREATE INDEX IF NOT EXISTS sync_events_seq ON sync_events(seq)",
  // The own-history check reads a host's newest entry on every run.
  "CREATE INDEX IF NOT EXISTS sync_rows_host_seq ON sync_rows(sync_host, seq)",
  "CREATE INDEX IF NOT EXISTS sync_events_host_seq ON sync_events(sync_host, seq)",
];

/** Columns of `events` that are not content (the payload never carries them). */
const EVENT_NON_CONTENT = new Set(["id", "uid", "sync_host", "sync_dirty"]);

/**
 * Local `sync_meta` key set in the same transaction that inserts a pulled
 * events page, and deleted only after a rebuild succeeds. A run that dies
 * between those two points (network error on a later page, a throw from
 * the rebuild, a crash) leaves it set, and the next run rebuilds first.
 * Its value is a fresh token on every set, so a rebuild only clears the
 * marker it saw: one set by a concurrent sync meanwhile survives.
 */
const REBUILD_PENDING = "rebuild_pending";
/**
 * Set (to the server id) when the server is found unknown, in the same
 * transaction that resets the pull cursors; cleared only with the
 * `server_id` store after a re-seed push completes in full. While it is
 * set every run treats the server as unknown: pulls start from 0 and
 * pushes re-seed, so neither a pull-only run, an interrupted re-seed nor
 * another host's writes can erase the decision.
 */
const RESEED_PENDING = "reseed_pending";
/**
 * Set (to a fresh ULID) whenever the cursors are reset to 0, cleared
 * (compare-and-delete) once a pull has run to the end. While it is set the
 * pull takes this host's own rows and events too: a machine reinstalled or
 * restored under the same HOST_SLUG starts with an empty database and must
 * get back what it pushed before. It is also set, with the same cursor
 * reset, when the server's newest own event or row is missing locally
 * (`ownHistoryMissing`): a tempad.db restored from an older backup keeps
 * its server id, cursors and probes, so it never looks unknown, yet lacks
 * everything it pushed after that backup. Own rows tie on `(stamp, host)` or lose
 * to a newer local version, and own events dedupe by uid, so the only cost
 * is bandwidth during one full pull.
 */
const PULL_OWN_PENDING = "pull_own_pending";
/** The last event / mirror row or tombstone this host saw land on the server. */
const PUSH_PROBE_EVENT = "push_probe_event";
const PUSH_PROBE_ROW = "push_probe_row";

const META_UPSERT =
  "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";

function localMeta(database: Database, key: string): string | null {
  return (
    (
      database.query("SELECT value FROM sync_meta WHERE key = ?").get(key) as {
        value: string;
      } | null
    )?.value ?? null
  );
}

function defaultRebuild(database: Database, options: RebuildOptions): void {
  registerAllProjections();
  rebuildAll(database, options);
}

function setRebuildMarker(database: Database): void {
  database.query(META_UPSERT).run(REBUILD_PENDING, newUlid());
}

/**
 * Compare-and-delete: clears the marker only if it still holds `token`, so
 * a page pulled by a concurrent run after the rebuild read its events
 * (which sets a fresh token) keeps the marker for the next rebuild.
 */
export function clearRebuildMarker(database: Database, token: string): void {
  database.query("DELETE FROM sync_meta WHERE key = ? AND value = ?").run(REBUILD_PENDING, token);
}

/**
 * Rebuilds the projections when a pulled page left them stale. The marker
 * is cleared in `beforeCommit`, inside the rebuild's own transaction: a
 * rebuild that rolls back leaves it set, one that commits takes it along.
 */
function rebuildIfPending(
  database: Database,
  rebuild: NonNullable<SyncRunOptions["rebuildProjections"]>,
): boolean {
  const token = localMeta(database, REBUILD_PENDING);
  if (token === null) return false;
  rebuild(database, { beforeCommit: (inside) => clearRebuildMarker(inside, token) });
  return true;
}

/**
 * Whether the server lost a write this host saw it accept: the last pushed
 * event's uid is gone, or the last pushed row is gone or older than what
 * was sent. Unlike the clock, a restored server cannot pass this by other
 * hosts moving its clock forward.
 */
async function pushProbeLost(database: Database, remote: SyncRemote): Promise<boolean> {
  const event = localMeta(database, PUSH_PROBE_EVENT);
  if (event !== null) {
    const found = await remote.query("SELECT 1 AS found FROM sync_events WHERE uid = ?", [event]);
    if (found.length === 0) return true;
  }
  const row = localMeta(database, PUSH_PROBE_ROW);
  if (row !== null) {
    const probe = JSON.parse(row) as { tbl: string; pk: string; stamp: string; host: string };
    const found = await remote.query(
      "SELECT 1 AS found FROM sync_rows WHERE tbl = ? AND pk = ? AND (sync_updated_at, sync_host) >= (?, ?)",
      [probe.tbl, probe.pk, probe.stamp, probe.host],
    );
    if (found.length === 0) return true;
  }
  return false;
}

/**
 * Whether the server holds own history this database lacks: the newest
 * event, or the newest mirror row or tombstone, tagged with this host's
 * slug (by server seq) is not held locally at that version or newer. In
 * normal operation the newest own entry is one this database pushed, so it
 * never fires; a false positive costs one full pull.
 */
async function ownHistoryMissing(
  database: Database,
  remote: SyncRemote,
  own: string,
  shapes: Map<string, MirrorShape>,
): Promise<boolean> {
  const [event] = await remote.query(
    "SELECT uid FROM sync_events WHERE sync_host = ? ORDER BY seq DESC LIMIT 1",
    [own],
  );
  if (
    event !== undefined &&
    database.query("SELECT 1 FROM events WHERE uid = ?").get(String(event.uid)) === null
  ) {
    return true;
  }
  const [row] = await remote.query(
    "SELECT tbl, pk, sync_updated_at FROM sync_rows WHERE sync_host = ? ORDER BY seq DESC LIMIT 1",
    [own],
  );
  if (row === undefined) return false;
  const shape = shapes.get(String(row.tbl));
  if (shape === undefined) return false; // a table this schema does not have
  const pushed: [string, string] = [String(row.sync_updated_at), own];
  const keyValues = JSON.parse(String(row.pk)) as SqlValue[];
  const keyWhere = shape.table.keyColumns.map((column) => `${quoted(column)} = ?`).join(" AND ");
  const local = database
    .query(`SELECT sync_updated_at, sync_host FROM ${shape.table.name} WHERE ${keyWhere}`)
    .get(...keyValues) as { sync_updated_at: string | null; sync_host: string | null } | null;
  if (local !== null && !isNewer(pushed, [local.sync_updated_at ?? "", local.sync_host ?? own])) {
    return false;
  }
  const tombstone = database
    .query("SELECT deleted_at, sync_host FROM sync_tombstones WHERE tbl = ? AND pk = ?")
    .get(shape.table.name, String(row.pk)) as {
    deleted_at: string;
    sync_host: string | null;
  } | null;
  return tombstone === null || isNewer(pushed, [tombstone.deleted_at, tombstone.sync_host ?? own]);
}

function storeRowProbe(database: Database, tbl: string, pk: string, stamp: string, host: string) {
  database.query(META_UPSERT).run(PUSH_PROBE_ROW, JSON.stringify({ tbl, pk, stamp, host }));
}

/**
 * Same event content on both sides, compared over the columns both carry
 * (a newer schema may add one). Two different events under one uid must
 * never be silently merged.
 */
function sameEventContent(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  for (const column of Object.keys(left)) {
    if (!(column in right)) continue;
    if ((left[column] ?? null) !== (right[column] ?? null)) return false;
  }
  return true;
}

export class EventCollisionError extends Error {}

const CLOCK_BUMP = "UPDATE sync_clock SET seq = seq + 1 WHERE id = 1";
const CURRENT_SEQ = "(SELECT seq FROM sync_clock WHERE id = 1)";
const RAISE_SCHEMA_VERSION =
  "INSERT INTO sync_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE CAST(sync_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)";
const REMOTE_ROW_UPSERT = `INSERT INTO sync_rows (tbl, pk, data, sync_host, sync_updated_at, seq) VALUES (?, ?, ?, ?, ?, ${CURRENT_SEQ})
ON CONFLICT (tbl, pk) DO UPDATE SET data = excluded.data, sync_host = excluded.sync_host, sync_updated_at = excluded.sync_updated_at, seq = excluded.seq
WHERE (excluded.sync_updated_at, excluded.sync_host) > (sync_rows.sync_updated_at, sync_rows.sync_host)`;
const REMOTE_EVENT_INSERT = `INSERT INTO sync_events (uid, data, sync_host, seq) VALUES (?, ?, ?, ${CURRENT_SEQ}) ON CONFLICT (uid) DO NOTHING`;

/**
 * The conflict rule: `(stamp, host)` compared as a row value, newer stamp
 * first, lexically greater host on a tie. Same comparison the server's and
 * the local upserts' `WHERE` clauses make in SQL (all values are ASCII, so
 * JS and SQLite BINARY ordering agree).
 */
export function isNewer(candidate: [string, string], current: [string, string]): boolean {
  if (candidate[0] !== current[0]) return candidate[0] > current[0];
  return candidate[1] > current[1];
}

function columnsOf(database: Database, table: string): string[] {
  return (
    database.query(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]
  ).map((row) => row.name);
}

function quoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function jsonValue(value: unknown, where: string): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return value;
  throw new Error(`${where}: cannot sync a ${typeof value} column value`);
}

function toJson(row: Record<string, unknown>, columns: readonly string[], where: string): string {
  const object: Record<string, SqlValue> = {};
  for (const column of columns) {
    const value = jsonValue(row[column], `${where}.${column}`);
    object[column] = typeof value === "bigint" ? Number(value) : value;
  }
  return JSON.stringify(object);
}

interface ForeignParent {
  parent: SyncedUpsertTable;
  /** Child columns, in the parent's key-column order. */
  childColumns: string[];
}

interface MirrorShape {
  table: SyncedUpsertTable;
  /** Content columns that sync: every column but the sync ones and localColumns. */
  content: string[];
  contentSet: Set<string>;
  parents: ForeignParent[];
}

function mirrorShapes(database: Database): Map<string, MirrorShape> {
  const shapes = new Map<string, MirrorShape>();
  const byName = new Map(SYNCED_UPSERT_TABLES.map((table) => [table.name, table]));
  for (const table of SYNCED_UPSERT_TABLES) {
    const excluded = new Set([...MIRROR_SYNC_COLUMNS, ...table.localColumns]);
    const content = columnsOf(database, table.name).filter((column) => !excluded.has(column));
    const foreignRows = database
      .query(
        `SELECT id, seq, "table" AS parent, "from" AS child, "to" AS target FROM pragma_foreign_key_list('${table.name}') ORDER BY id, seq`,
      )
      .all() as { id: number; parent: string; child: string; target: string | null }[];
    const groups = new Map<number, typeof foreignRows>();
    for (const row of foreignRows) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
    const parents: ForeignParent[] = [];
    for (const group of groups.values()) {
      const parent = byName.get(group[0]?.parent ?? "");
      if (parent === undefined) continue;
      const childColumns = parent.keyColumns.map((key, index) => {
        const match = group.find((row) => row.target === key) ?? group[index];
        if (match === undefined)
          throw new Error(`${table.name}: foreign key to ${parent.name} does not cover ${key}`);
        return match.child;
      });
      parents.push({ parent, childColumns });
    }
    shapes.set(table.name, { table, content, contentSet: new Set(content), parents });
  }
  return shapes;
}

/**
 * One sync run: schema gate, push, pull, rebuild when the pull inserted an
 * event. Throws on any remote error (network, auth) and on the schema gate;
 * every batch or page already committed stays committed on both sides.
 */
export async function runSyncEngine(
  database: Database,
  remote: SyncRemote,
  options: SyncRunOptions,
): Promise<SyncRunSummary> {
  const own = options.hostSlug;
  const rebuild = options.rebuildProjections ?? defaultRebuild;
  const warn = options.warn ?? ((message: string) => console.error(message));
  // Before any network call: a previous run's pulled events must be
  // projected even when this run is push-only or cannot reach the server.
  // A failure here must not block push and pull (new local work would never
  // be backed up, and a correcting event never pulled): keep the marker,
  // warn, and retry at the end, where a second failure fails the run.
  let rebuiltFirst = false;
  try {
    rebuiltFirst = rebuildIfPending(database, rebuild);
  } catch (error) {
    warn(
      `sync: projection rebuild failed, retrying after push and pull: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const localVersion = (database.query("PRAGMA user_version").get() as { user_version: number })
    .user_version;

  await remote.write([
    ...REMOTE_SCHEMA.map((sql) => ({ sql, args: [] })),
    { sql: "INSERT INTO sync_clock (id, seq) VALUES (1, 0) ON CONFLICT (id) DO NOTHING", args: [] },
    {
      sql: "INSERT INTO sync_meta (key, value) VALUES ('server_id', ?) ON CONFLICT (key) DO NOTHING",
      args: [newUlid()],
    },
    {
      sql: "INSERT INTO sync_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO NOTHING",
      args: [String(localVersion)],
    },
  ]);

  const meta = new Map(
    (await remote.query("SELECT key, value FROM sync_meta")).map((row) => [
      String(row.key),
      String(row.value),
    ]),
  );
  const remoteVersion = Number.parseInt(meta.get("schema_version") ?? "0", 10);
  if (remoteVersion > localVersion) {
    throw new SchemaGateError(
      `remote holds data from tempad schema ${remoteVersion}; upgrade tempad on this host (schema ${localVersion})`,
    );
  }
  if (remoteVersion < localVersion) {
    // Raise it now, not only with the first push batch: a pull-only run or
    // one with nothing dirty must still stop older hosts at the gate.
    await remote.write([{ sql: RAISE_SCHEMA_VERSION, args: [String(localVersion)] }]);
  }
  let serverId = meta.get("server_id") ?? "";
  const clock = Number(
    (await remote.query("SELECT seq FROM sync_clock WHERE id = 1"))[0]?.seq ?? 0,
  );

  const storedId = localMeta(database, "server_id");
  const maxCursor = (
    database.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_cursors").get() as { seq: number }
  ).seq;
  // Unknown server: a re-seed still pending from an earlier run, a
  // different id, a clock behind what this host already pulled, or a write
  // this host saw accepted that is gone (restored from an older backup that
  // kept its id).
  const lost =
    storedId === serverId && (clock < maxCursor || (await pushProbeLost(database, remote)));
  let unknown = localMeta(database, RESEED_PENDING) !== null || storedId !== serverId || lost;
  if (lost) {
    // This server lost writes yet kept its id, so a host that never pushed
    // since the backup would see nothing wrong (another host's re-seed can
    // even put its probes back). Rotate the id so every host re-seeds and
    // pulls from 0. Compare-and-set: when two hosts detect it at once,
    // only one rotation lands and both adopt whatever id the server holds.
    await remote.write([
      {
        sql: "UPDATE sync_meta SET value = ? WHERE key = 'server_id' AND value = ?",
        args: [newUlid(), serverId],
      },
    ]);
    const current = await remote.query("SELECT value FROM sync_meta WHERE key = 'server_id'");
    serverId = String(current[0]?.value ?? "");
  }
  if (unknown) {
    // Durable: every later run keeps re-seeding and pulling from 0 until a
    // re-seed push completes, whatever runs in between.
    database.transaction(() => {
      database.query(META_UPSERT).run(RESEED_PENDING, serverId);
      database.query(META_UPSERT).run(PULL_OWN_PENDING, newUlid());
      database.exec("DELETE FROM sync_cursors");
    })();
  }

  const shapes = mirrorShapes(database);
  if (
    !unknown &&
    localMeta(database, PULL_OWN_PENDING) === null &&
    (await ownHistoryMissing(database, remote, own, shapes))
  ) {
    // Restored from an older backup: the server is fine and knows this
    // host, but this database lacks writes it pushed later. No re-seed
    // (nothing on the server is missing); pull everything from 0, own rows
    // included. Durable like the unknown path: a push-only or interrupted
    // run keeps the marker and the reset cursors.
    database.transaction(() => {
      database.query(META_UPSERT).run(PULL_OWN_PENDING, newUlid());
      database.exec("DELETE FROM sync_cursors");
    })();
  }
  const summary: SyncRunSummary = {
    pushed: { events: 0, rows: 0, tombstones: 0 },
    pulled: { events: 0, rows: 0, tombstones: 0 },
    rebuilt: rebuiltFirst,
    reseeded: false,
  };

  if (options.push) {
    const context: PushContext = {
      database,
      remote,
      batchSize: options.batchSize,
      reseed: unknown,
      schemaVersion: String(localVersion),
    };
    fillHosts(database, own);
    for (const shape of shapes.values()) summary.pushed.rows += await pushMirror(context, shape);
    summary.pushed.events += await pushEvents(context);
    summary.pushed.tombstones += await pushTombstones(context);
    if (unknown) {
      // The re-seed completed in full: trust this server from now on. The
      // cursors were reset when the marker was set, so the pull below
      // still starts from 0.
      database.transaction(() => {
        database.query(META_UPSERT).run("server_id", serverId);
        database
          .query("DELETE FROM sync_meta WHERE key = ? AND value = ?")
          .run(RESEED_PENDING, serverId);
      })();
      summary.reseeded = true;
      unknown = false;
    }
  }

  if (options.pull) {
    // A pull-only run against an unknown server starts from 0 (the cursors
    // were reset above) and leaves the marker and the id alone, so the next
    // push still re-seeds.
    const pageSize = options.pageSize ?? options.batchSize;
    // After a cursor reset, own rows are pulled too (see PULL_OWN_PENDING);
    // otherwise they are skipped, since this host already holds them.
    const pullOwn = localMeta(database, PULL_OWN_PENDING);
    const skipHost = pullOwn === null ? own : null;
    const rowCounts = await pullRows(database, remote, own, skipHost, pageSize, shapes);
    summary.pulled.rows = rowCounts.rows;
    summary.pulled.tombstones = rowCounts.tombstones;
    summary.pulled.events = await pullEvents(database, remote, skipHost, pageSize);
    if (pullOwn !== null) {
      database
        .query("DELETE FROM sync_meta WHERE key = ? AND value = ?")
        .run(PULL_OWN_PENDING, pullOwn);
    }
  }

  if (rebuildIfPending(database, rebuild)) summary.rebuilt = true;

  return summary;
}

interface PushContext {
  database: Database;
  remote: SyncRemote;
  batchSize: number;
  reseed: boolean;
  schemaVersion: string;
}

function fillHosts(database: Database, own: string): void {
  database.transaction(() => {
    for (const table of SYNCED_UPSERT_TABLES) {
      database.query(`UPDATE ${table.name} SET sync_host = ? WHERE sync_host IS NULL`).run(own);
    }
    database.query("UPDATE events SET sync_host = ? WHERE sync_host IS NULL").run(own);
    database.query("UPDATE sync_tombstones SET sync_host = ? WHERE sync_host IS NULL").run(own);
  })();
}

/** Every push batch: bump the clock, raise the schema version, then the rows. */
function batchPrelude(context: PushContext): RemoteStatement[] {
  return [
    { sql: CLOCK_BUMP, args: [] },
    { sql: RAISE_SCHEMA_VERSION, args: [context.schemaVersion] },
  ];
}

/**
 * Dirty rows, or every row on a re-seed. A re-seed sends other hosts' rows
 * and events too, with their own host and stamp: a host that has retired
 * since must not vanish with the old server. The server-side conflict rule
 * and `ON CONFLICT (uid) DO NOTHING` keep that idempotent.
 */
const OUTBOX = "(sync_dirty = 1 OR ? = 1)";

async function pushMirror(context: PushContext, shape: MirrorShape): Promise<number> {
  const { database } = context;
  const name = shape.table.name;
  const keys = shape.table.keyColumns.map(quoted).join(", ");
  const select = database.query(
    `SELECT rowid AS sync_rowid, json_array(${keys}) AS sync_pk, ${shape.content.map(quoted).join(", ")}, sync_host, sync_updated_at
       FROM ${name} WHERE (? IS NULL OR rowid > ?) AND ${OUTBOX} ORDER BY rowid LIMIT ?`,
  );
  const mark = database.query(
    `UPDATE ${name} SET sync_dirty = 0 WHERE rowid = ? AND sync_dirty = 1 AND sync_updated_at = ?`,
  );
  // No lower bound on the first page: an INTEGER PRIMARY KEY table's rowid
  // is the id itself, and a source id of 0 or below is valid.
  let after: number | null = null;
  let pushed = 0;
  for (;;) {
    const rows = select.all(after, after, context.reseed ? 1 : 0, context.batchSize) as Record<
      string,
      unknown
    >[];
    if (rows.length === 0) return pushed;
    const statements = batchPrelude(context);
    for (const row of rows) {
      statements.push({
        sql: REMOTE_ROW_UPSERT,
        args: [
          name,
          row.sync_pk as string,
          toJson(row, shape.content, name),
          row.sync_host as string,
          row.sync_updated_at as string,
        ],
      });
    }
    await context.remote.write(statements);
    const probe = rows.at(-1) as Record<string, unknown>;
    database.transaction(() => {
      for (const row of rows) mark.run(row.sync_rowid as number, row.sync_updated_at as string);
      storeRowProbe(
        database,
        name,
        probe.sync_pk as string,
        probe.sync_updated_at as string,
        probe.sync_host as string,
      );
    })();
    pushed += rows.length;
    after = rows.at(-1)?.sync_rowid as number;
  }
}

async function pushEvents(context: PushContext): Promise<number> {
  const { database } = context;
  const content = columnsOf(database, "events").filter((column) => !EVENT_NON_CONTENT.has(column));
  const select = database.query(
    `SELECT uid, sync_host, ${content.map(quoted).join(", ")} FROM events
      WHERE uid IS NOT NULL AND uid > ? AND ${OUTBOX} ORDER BY uid LIMIT ?`,
  );
  const mark = database.query("UPDATE events SET sync_dirty = 0 WHERE uid = ? AND sync_dirty = 1");
  let after = "";
  let pushed = 0;
  for (;;) {
    const rows = select.all(after, context.reseed ? 1 : 0, context.batchSize) as Record<
      string,
      unknown
    >[];
    if (rows.length === 0) return pushed;
    const statements = batchPrelude(context);
    for (const row of rows) {
      statements.push({
        sql: REMOTE_EVENT_INSERT,
        args: [row.uid as string, toJson(row, content, "events"), row.sync_host as string],
      });
    }
    await context.remote.write(statements);
    await verifyPushedEvents(context.remote, rows, content);
    database.transaction(() => {
      for (const row of rows) mark.run(row.uid as string);
      database.query(META_UPSERT).run(PUSH_PROBE_EVENT, rows.at(-1)?.uid as string);
    })();
    pushed += rows.length;
    after = rows.at(-1)?.uid as string;
  }
}

/**
 * After an events batch commits: the server must hold exactly what was
 * sent under each uid. A different event already there under the same uid
 * (a cross-host uid collision) would otherwise be dropped by
 * `ON CONFLICT (uid) DO NOTHING` and marked pushed, losing it for good.
 * Throwing leaves the batch dirty, so every later run fails loudly too.
 */
async function verifyPushedEvents(
  remote: SyncRemote,
  rows: Record<string, unknown>[],
  content: string[],
): Promise<void> {
  const uids = rows.map((row) => row.uid as string);
  const stored = new Map(
    (
      await remote.query(
        `SELECT uid, data FROM sync_events WHERE uid IN (${uids.map(() => "?").join(", ")})`,
        uids,
      )
    ).map((row) => [String(row.uid), String(row.data)]),
  );
  for (const row of rows) {
    const uid = row.uid as string;
    const data = stored.get(uid);
    const sent = JSON.parse(toJson(row, content, "events")) as Record<string, unknown>;
    if (data === undefined || !sameEventContent(sent, JSON.parse(data))) {
      throw new EventCollisionError(
        `event uid ${uid} is held by the server with different content; a different host minted the same uid. Not marking it pushed`,
      );
    }
  }
}

async function pushTombstones(context: PushContext): Promise<number> {
  const { database } = context;
  const select = database.query(
    `SELECT rowid AS sync_rowid, tbl, pk, deleted_at, sync_host FROM sync_tombstones
      WHERE rowid > ? AND ${OUTBOX} ORDER BY rowid LIMIT ?`,
  );
  const mark = database.query(
    "UPDATE sync_tombstones SET sync_dirty = 0 WHERE rowid = ? AND sync_dirty = 1 AND deleted_at = ?",
  );
  let after = 0;
  let pushed = 0;
  for (;;) {
    const rows = select.all(after, context.reseed ? 1 : 0, context.batchSize) as {
      sync_rowid: number;
      tbl: string;
      pk: string;
      deleted_at: string;
      sync_host: string;
    }[];
    if (rows.length === 0) return pushed;
    const statements = batchPrelude(context);
    for (const row of rows) {
      statements.push({
        sql: REMOTE_ROW_UPSERT,
        args: [row.tbl, row.pk, null, row.sync_host, row.deleted_at],
      });
    }
    await context.remote.write(statements);
    const probe = rows.at(-1) as (typeof rows)[number];
    database.transaction(() => {
      for (const row of rows) mark.run(row.sync_rowid, row.deleted_at);
      storeRowProbe(database, probe.tbl, probe.pk, probe.deleted_at, probe.sync_host);
    })();
    pushed += rows.length;
    after = rows.at(-1)?.sync_rowid as number;
  }
}

interface RemoteRow {
  tbl: string;
  pk: string;
  data: string | null;
  sync_host: string;
  sync_updated_at: string;
}

function readCursor(database: Database, stream: "rows" | "events"): number {
  return (
    (
      database.query("SELECT seq FROM sync_cursors WHERE stream = ?").get(stream) as {
        seq: number;
      } | null
    )?.seq ?? 0
  );
}

function writeCursor(database: Database, stream: "rows" | "events", seq: number): void {
  database
    .query(
      "INSERT INTO sync_cursors (stream, seq) VALUES (?, ?) ON CONFLICT (stream) DO UPDATE SET seq = excluded.seq",
    )
    .run(stream, seq);
}

/**
 * A page is every row of the first `pageSize` rows' seq values: the page
 * ends on a seq boundary, so advancing the cursor to its last seq never
 * skips the rest of a batch that shares it.
 */
function pageQuery(table: "sync_rows" | "sync_events", columns: string, order: string): string {
  // `sync_host IS NOT ?`: bound to a slug it skips that host's rows; bound
  // to NULL it skips none (the server always stores a host).
  return `SELECT ${columns}, seq FROM ${table}
           WHERE seq > ? AND sync_host IS NOT ?
             AND seq <= (SELECT MAX(seq) FROM (SELECT seq FROM ${table} WHERE seq > ? AND sync_host IS NOT ? ORDER BY seq LIMIT ?))
           ORDER BY seq, ${order}`;
}

class LocalApplier {
  private readonly statements = new Map<string, Statement>();

  constructor(
    private readonly database: Database,
    private readonly own: string,
    private readonly shapes: Map<string, MirrorShape>,
  ) {}

  private prepare(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.database.query(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  shape(tbl: string): MirrorShape | undefined {
    return this.shapes.get(tbl);
  }

  private keyWhere(shape: MirrorShape): string {
    return shape.table.keyColumns.map((column) => `${quoted(column)} = ?`).join(" AND ");
  }

  exists(shape: MirrorShape, keyValues: SqlValue[]): boolean {
    return (
      this.prepare(`SELECT 1 FROM ${shape.table.name} WHERE ${this.keyWhere(shape)}`).get(
        ...keyValues,
      ) !== null
    );
  }

  pkJson(values: SqlValue[]): string {
    const placeholders = values.map(() => "?").join(", ");
    return (
      this.prepare(`SELECT json_array(${placeholders}) AS pk`).get(...values) as { pk: string }
    ).pk;
  }

  /** Applies a pulled row or tombstone; returns whether it changed anything. */
  apply(row: RemoteRow): "row" | "tombstone" | null {
    const shape = this.shapes.get(row.tbl);
    if (shape === undefined) return null; // a table this schema does not have
    const keyValues = JSON.parse(row.pk) as SqlValue[];
    if (row.data === null) {
      return this.applyTombstone(shape, row, keyValues) ? "tombstone" : null;
    }
    return this.applyRow(shape, row, keyValues) ? "row" : null;
  }

  private applyRow(shape: MirrorShape, row: RemoteRow, keyValues: SqlValue[]): boolean {
    const name = shape.table.name;
    const tombstone = this.prepare(
      "SELECT deleted_at, sync_host FROM sync_tombstones WHERE tbl = ? AND pk = ?",
    ).get(name, row.pk) as { deleted_at: string; sync_host: string | null } | null;
    if (
      tombstone !== null &&
      !isNewer(
        [row.sync_updated_at, row.sync_host],
        [tombstone.deleted_at, tombstone.sync_host ?? this.own],
      )
    ) {
      return false;
    }

    const data = JSON.parse(row.data as string) as Record<string, SqlValue>;
    // Unknown pulled columns are dropped (safe because of the schema gate);
    // host-local columns are never written by a pull.
    const columns = Object.keys(data).filter((column) => shape.contentSet.has(column));
    const keys = shape.table.keyColumns;
    const updates = columns
      .filter((column) => !keys.includes(column))
      .map((column) => `${quoted(column)} = excluded.${quoted(column)}`);
    const sql = `INSERT INTO ${name} (${[...columns, "sync_host", "sync_updated_at", "sync_dirty"].map(quoted).join(", ")})
      VALUES (${columns.map(() => "?").join(", ")}, ?, ?, 0)
      ON CONFLICT (${keys.map(quoted).join(", ")}) DO UPDATE SET ${[...updates, "sync_host = excluded.sync_host", "sync_updated_at = excluded.sync_updated_at", "sync_dirty = 0"].join(", ")}
      WHERE (excluded.sync_updated_at, excluded.sync_host) > (COALESCE(${name}.sync_updated_at, ''), COALESCE(${name}.sync_host, ?))`;
    const result = this.prepare(sql).run(
      ...columns.map((column) => data[column] ?? null),
      row.sync_host,
      row.sync_updated_at,
      this.own,
    );
    if (result.changes === 0) return false;

    // On a stamp tie (won by host) the content update fires the local
    // restamp trigger; put the remote stamp and host back, clean.
    this.prepare(
      `UPDATE ${name} SET sync_updated_at = ?, sync_host = ?, sync_dirty = 0 WHERE ${this.keyWhere(shape)}
         AND (sync_updated_at IS NOT ? OR sync_host IS NOT ? OR sync_dirty != 0)`,
    ).run(row.sync_updated_at, row.sync_host, ...keyValues, row.sync_updated_at, row.sync_host);
    if (tombstone !== null) {
      this.prepare("DELETE FROM sync_tombstones WHERE tbl = ? AND pk = ?").run(name, row.pk);
    }
    return true;
  }

  private applyTombstone(shape: MirrorShape, row: RemoteRow, keyValues: SqlValue[]): boolean {
    const name = shape.table.name;
    const local = this.prepare(
      `SELECT sync_updated_at, sync_host FROM ${name} WHERE ${this.keyWhere(shape)}`,
    ).get(...keyValues) as { sync_updated_at: string | null; sync_host: string | null } | null;

    if (local !== null) {
      if (
        !isNewer(
          [row.sync_updated_at, row.sync_host],
          [local.sync_updated_at ?? "", local.sync_host ?? this.own],
        )
      ) {
        return false;
      }
      this.prepare(`DELETE FROM ${name} WHERE ${this.keyWhere(shape)}`).run(...keyValues);
      // The delete trigger just wrote a local, dirty tombstone; rewrite it
      // with the remote stamp and host so it is not pushed back.
      this.prepare(
        `INSERT INTO sync_tombstones (tbl, pk, deleted_at, sync_host, sync_dirty) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (tbl, pk) DO UPDATE SET deleted_at = excluded.deleted_at, sync_host = excluded.sync_host, sync_dirty = 0`,
      ).run(name, row.pk, row.sync_updated_at, row.sync_host);
      return true;
    }

    const result = this.prepare(
      `INSERT INTO sync_tombstones (tbl, pk, deleted_at, sync_host, sync_dirty) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (tbl, pk) DO UPDATE SET deleted_at = excluded.deleted_at, sync_host = excluded.sync_host, sync_dirty = 0
       WHERE (excluded.deleted_at, excluded.sync_host) > (sync_tombstones.deleted_at, COALESCE(sync_tombstones.sync_host, ?))`,
    ).run(name, row.pk, row.sync_updated_at, row.sync_host, this.own);
    return result.changes > 0;
  }

  /**
   * Parents a page's child rows reference that neither this database nor
   * the page holds. A parent updated after its child carries a higher seq,
   * so it can arrive pages later; foreign keys are only deferred to the end
   * of the page's transaction.
   */
  missingParents(page: RemoteRow[]): Map<string, Set<string>> {
    const inPage = new Set(
      page.filter((row) => row.data !== null).map((row) => `${row.tbl}\u0000${row.pk}`),
    );
    const missing = new Map<string, Set<string>>();
    for (const row of page) {
      if (row.data === null) continue;
      const shape = this.shapes.get(row.tbl);
      if (shape === undefined || shape.parents.length === 0) continue;
      const data = JSON.parse(row.data) as Record<string, SqlValue>;
      for (const { parent, childColumns } of shape.parents) {
        const values = childColumns.map((column) => data[column] ?? null);
        if (values.some((value) => value === null)) continue;
        const parentShape = this.shapes.get(parent.name) as MirrorShape;
        const pk = this.pkJson(values);
        if (inPage.has(`${parent.name}\u0000${pk}`) || this.exists(parentShape, values)) continue;
        const set = missing.get(parent.name) ?? new Set<string>();
        set.add(pk);
        missing.set(parent.name, set);
      }
    }
    return missing;
  }
}

async function fetchParents(
  remote: SyncRemote,
  missing: Map<string, Set<string>>,
): Promise<RemoteRow[]> {
  const rows: RemoteRow[] = [];
  for (const [tbl, pks] of missing) {
    const list = [...pks];
    for (let index = 0; index < list.length; index += 100) {
      const chunk = list.slice(index, index + 100);
      const found = await remote.query(
        `SELECT tbl, pk, data, sync_host, sync_updated_at FROM sync_rows WHERE tbl = ? AND pk IN (${chunk.map(() => "?").join(", ")})`,
        [tbl, ...chunk],
      );
      rows.push(...(found as unknown as RemoteRow[]));
    }
  }
  return rows;
}

async function pullRows(
  database: Database,
  remote: SyncRemote,
  own: string,
  skipHost: string | null,
  pageSize: number,
  shapes: Map<string, MirrorShape>,
): Promise<{ rows: number; tombstones: number }> {
  const applier = new LocalApplier(database, own, shapes);
  const sql = pageQuery("sync_rows", "tbl, pk, data, sync_host, sync_updated_at", "tbl, pk");
  const counts = { rows: 0, tombstones: 0 };
  for (;;) {
    const cursor = readCursor(database, "rows");
    const page = (await remote.query(sql, [
      cursor,
      skipHost,
      cursor,
      skipHost,
      pageSize,
    ])) as unknown as (RemoteRow & {
      seq: number;
    })[];
    if (page.length === 0) return counts;
    const parents = await fetchParents(remote, applier.missingParents(page));
    const last = Number(page.at(-1)?.seq);
    database.transaction(() => {
      database.exec("PRAGMA defer_foreign_keys = ON");
      for (const row of [...parents, ...page]) {
        const applied = applier.apply(row);
        if (applied === "row") counts.rows += 1;
        if (applied === "tombstone") counts.tombstones += 1;
      }
      writeCursor(database, "rows", last);
    })();
  }
}

async function pullEvents(
  database: Database,
  remote: SyncRemote,
  skipHost: string | null,
  pageSize: number,
): Promise<number> {
  const content = new Set(
    columnsOf(database, "events").filter((column) => !EVENT_NON_CONTENT.has(column)),
  );
  const sql = pageQuery("sync_events", "uid, data, sync_host", "uid");
  const statements = new Map<string, Statement>();
  const localByUid = database.query(
    `SELECT ${[...content].map(quoted).join(", ")} FROM events WHERE uid = ?`,
  );
  let inserted = 0;
  for (;;) {
    const cursor = readCursor(database, "events");
    const page = (await remote.query(sql, [
      cursor,
      skipHost,
      cursor,
      skipHost,
      pageSize,
    ])) as unknown as {
      uid: string;
      data: string;
      sync_host: string;
      seq: number;
    }[];
    if (page.length === 0) return inserted;
    const last = Number(page.at(-1)?.seq);
    let pageInserted = 0;
    database.transaction(() => {
      database.exec("PRAGMA defer_foreign_keys = ON");
      for (const event of page) {
        const data = JSON.parse(event.data) as Record<string, SqlValue>;
        const columns = Object.keys(data).filter((column) => content.has(column));
        // Only a duplicate uid is skipped; any other constraint violation
        // throws and rolls the page back, so the cursor never passes it.
        const insertSql = `INSERT INTO events (uid, sync_host, sync_dirty, ${columns.map(quoted).join(", ")})
          VALUES (?, ?, 0, ${columns.map(() => "?").join(", ")}) ON CONFLICT (uid) DO NOTHING`;
        let statement = statements.get(insertSql);
        if (statement === undefined) {
          statement = database.query(insertSql);
          statements.set(insertSql, statement);
        }
        const result = statement.run(
          event.uid,
          event.sync_host,
          ...columns.map((column) => data[column] ?? null),
        );
        if (result.changes === 0) {
          // Same uid already here: it must be the same event. A different
          // one is a uid collision; throwing rolls the page back and holds
          // the cursor instead of silently keeping only one of them.
          const local = localByUid.get(event.uid) as Record<string, unknown> | null;
          if (local !== null && !sameEventContent(data, local)) {
            throw new EventCollisionError(
              `pulled event uid ${event.uid} collides with a different local event; a different host minted the same uid`,
            );
          }
        }
        inserted += result.changes;
        pageInserted += result.changes;
      }
      if (pageInserted > 0) setRebuildMarker(database);
      writeCursor(database, "events", last);
    })();
  }
}
