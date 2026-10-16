import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { encodeTime } from "ulid";
import { normalizeOffsetTimestamp } from "../collect/github/log";
import { ulidAfter } from "../intent/ids";
import { ensureMirrorTriggers, reconcileMirrorTriggers } from "../sync/triggers";
import { loadMigrations, type MigrationFile } from "./migration-files";

/**
 * From this version on, the push-sync mirror triggers exist only while
 * `sync_meta.mirror_sync_enabled` is set (src/sync/triggers.ts). Every pending
 * migration from here applies inside ONE transaction, which runs
 * `reconcileMirrorTriggers` once at its end, after the last of them, and then
 * commits (see `applyMigrations`).
 *
 * One transaction, because 0022 drops the triggers: were each step its own
 * commit, a database with sync enabled would sit without triggers between
 * 0022's commit and the last step's, and a w5 hook or collector holding the
 * database open could write a mirror row there that is never stamped or
 * tombstoned, so it never pushes (and the marker being set already, nothing
 * would ever restamp it). Reconciling only at the end, because
 * `mirror-triggers.sql` describes the head schema: installing it after an
 * intermediate step (say 22, on the way to a 25 that adds a mirror column the
 * triggers name) would make any 23 or 24 statement touching that mirror fail.
 */
const TRIGGER_GATE_VERSION = 22;

export interface OpenDatabaseOptions {
  /**
   * This machine's `HOST_SLUG`. When given, it is upserted into `sync_local`,
   * where the push-sync triggers and `EventStore.append` read it to tag every
   * row and event they write. Every CLI entry point passes `config.hostSlug`;
   * a database opened without one (tests, `:memory:`) writes `sync_host` NULL,
   * which push fills with its own slug before sending.
   */
  hostSlug?: string;
  /**
   * Stop after this migration version instead of migrating to head. For tests
   * that need a database exactly as an older release left it: rewinding
   * `user_version` after a full migration instead would replay non-ALTER
   * migrations (0019 onward) against tables that already have their columns.
   */
  upToVersion?: number;
  /**
   * How long a statement waits for another connection's write lock before
   * failing with SQLITE_BUSY. Defaults to 5000 ms. Tests pass a short value
   * so a deliberately blocked open fails fast.
   */
  busyTimeoutMs?: number;
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  const database = new Database(path);
  // First, before any other statement: a CLI command, the w5 hook and a sync
  // can all open the same file at once, and without a busy timeout the loser
  // of a lock race fails immediately instead of waiting its turn.
  database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000};`);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");

  const currentVersion = (database.query("PRAGMA user_version;").get() as { user_version: number })
    .user_version;

  const pending = loadMigrations().filter(
    (migration) =>
      migration.version > currentVersion &&
      (options.upToVersion === undefined || migration.version <= options.upToVersion),
  );
  // Below the gate, one transaction per migration; from it on, one for all.
  for (const migration of pending.filter((each) => each.version < TRIGGER_GATE_VERSION)) {
    applyMigrations(database, [migration], { reconcileTriggers: false });
  }
  const gated = pending.filter((each) => each.version >= TRIGGER_GATE_VERSION);
  if (gated.length > 0) applyMigrations(database, gated, { reconcileTriggers: true });

  if (hasColumn(database, "events", "uid")) backfillEventUids(database);
  if (userVersion(database) >= TRIGGER_GATE_VERSION) {
    try {
      ensureMirrorTriggers(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }
  if (options.hostSlug !== undefined && hasTable(database, "sync_local")) {
    try {
      recordHostSlug(database, options.hostSlug);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  return database;
}

/**
 * Records this host's slug in `sync_local`, writing only when the row is
 * missing or holds a different slug. Every CLI connection passes the slug, so
 * an unconditional upsert would make every open a write: even a read-only
 * `tempad report` would queue behind (or fail against) a long sync or rebuild
 * holding the write lock. A plain read never waits on a WAL writer, so the
 * common case (slug unchanged) opens without touching the lock at all.
 */
function recordHostSlug(database: Database, hostSlug: string): void {
  const row = database.query("SELECT host_slug FROM sync_local WHERE id = 1").get() as {
    host_slug: string | null;
  } | null;
  if (row !== null && row.host_slug === hostSlug) return;
  try {
    database
      .query(
        "INSERT INTO sync_local (id, host_slug) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET host_slug = excluded.host_slug",
      )
      .run(hostSlug);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot record host slug "${hostSlug}" in sync_local (another process may hold the database write lock): ${message}`,
    );
  }
}

function userVersion(database: Database): number {
  return (database.query("PRAGMA user_version;").get() as { user_version: number }).user_version;
}

function hasTable(database: Database, table: string): boolean {
  return (
    database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    null
  );
}

function hasColumn(database: Database, table: string, column: string): boolean {
  return (
    database.query("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column) !== null
  );
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const FORTY_BITS = (1n << 40n) - 1n;

/** The 80-bit random half of a ULID as 16 Crockford base32 characters. */
function encodeRandom80(value: bigint): string {
  let out = "";
  let rest = value;
  for (let index = 0; index < 16; index += 1) {
    out = CROCKFORD[Number(rest & 31n)] + out;
    rest >>= 5n;
  }
  return out;
}

/**
 * The deterministic uid of a legacy (pre-0019) event row: the same row gets
 * the same uid on every copy of the database, so two hosts that started from
 * one copied `tempad.db` never ship the same old event twice under two uids.
 *
 * - time (48 bits): `timeMs`, the row's `recorded_at` clamped by the caller to
 *   be non-decreasing in id order;
 * - random high 40 bits: the row `id`, big-endian, so rows sharing a
 *   (clamped) millisecond sort by id;
 * - random low 40 bits: the first 40 bits of SHA-256 over
 *   `recorded_at|kind|subject|payload` (the stored column values), so two
 *   databases whose rows share an id but not a content get different uids.
 *
 * Exported for tests.
 */
export function legacyEventUid(row: LegacyEventRow, timeMs: number): string {
  if (!Number.isSafeInteger(row.id) || row.id < 0 || BigInt(row.id) > FORTY_BITS) {
    throw new Error(
      `events row ${row.id} is beyond the 40-bit id ceiling of the legacy uid backfill`,
    );
  }
  const digest = createHash("sha256")
    .update(`${row.recorded_at}|${row.kind}|${row.subject}|${row.payload}`)
    .digest();
  const hash = BigInt(`0x${digest.subarray(0, 5).toString("hex")}`);
  return encodeTime(timeMs, 10) + encodeRandom80((BigInt(row.id) << 40n) | hash);
}

export interface LegacyEventRow {
  id: number;
  recorded_at: string;
  kind: string;
  subject: string;
  payload: string;
}

/**
 * Gives every event without a `uid` one, once: rows written before migration
 * 0019 (or inserted by hand, outside `EventStore`, since). Rows are walked in
 * `id` order; each gets `legacyEventUid` with its time clamped to
 * `max(recorded_at ms, previous row's time)`. With the clamp the time part
 * never decreases, and within one millisecond the id in the random half
 * breaks the tie, so the uids sort exactly like the ids even where
 * `recorded_at` goes backwards or repeats, and replaying `ORDER BY uid`
 * reproduces the old `ORDER BY id`. Every input is the row's own stored data
 * (and its predecessors'), so every copy of a database backfills identical
 * uids.
 *
 * The successor guard (`ulidAfter`) only matters when some event already
 * carries a uid at or above a row's deterministic one -- a NULL-uid row
 * inserted by hand after the migration, never a plain pre-0019 database. It
 * keeps id order there by adding a random increment to the previous uid, at
 * the cost of determinism for that row (and any later row it pushes past).
 * Rows that never hit the guard stay deterministic across copies.
 *
 * `uid IS NULL` is answered from the `events_uid` index, so this is a cheap
 * no-op on every open after the first.
 */
function backfillEventUids(database: Database): void {
  const pending = database.query("SELECT 1 AS pending FROM events WHERE uid IS NULL LIMIT 1").get();
  if (pending === null) return;

  // The rows and the maximum are read inside the write transaction. Two
  // processes opening the same database both see NULL uids. On a plain pre-0019
  // database the uids are deterministic, so a stale read would only recompute
  // the same values; the lock earns its keep in the mixed case, where some
  // uid already sits above a row's deterministic one and `ulidAfter` adds a
  // random increment. A stale read there hands out a uid for a row the other
  // process has already filled, and the append-only trigger aborts the open.
  const run = database.transaction(() => {
    const rows = database
      .query(
        "SELECT id, recorded_at, kind, subject, payload FROM events WHERE uid IS NULL ORDER BY id",
      )
      .all() as LegacyEventRow[];
    if (rows.length === 0) return;

    const maximum = (
      database.query("SELECT MAX(uid) AS uid FROM events").get() as {
        uid: string | null;
      }
    ).uid;
    const update = database.query("UPDATE events SET uid = ? WHERE id = ?");
    let previous = maximum;
    let previousTime = 0;
    for (const row of rows) {
      const recorded = Date.parse(row.recorded_at);
      if (Number.isNaN(recorded)) {
        throw new Error(`events row ${row.id} has an unparseable recorded_at: ${row.recorded_at}`);
      }
      const time = Math.max(recorded, previousTime);
      const uid = ulidAfter(legacyEventUid(row, time), previous);
      update.run(uid, row.id);
      previous = uid;
      previousTime = time;
    }
  });
  run.immediate();
}

interface CommitDateRow {
  rowid: number;
  authored_at: string;
  committed_at: string;
  sync_updated_at: string | null;
}

const OFFSET_FORM_COMMITS = `
  SELECT rowid, authored_at, committed_at, sync_updated_at
    FROM gh_commits
   WHERE authored_at GLOB '*[-+][0-9][0-9]:[0-9][0-9]'
      OR committed_at GLOB '*[-+][0-9][0-9]:[0-9][0-9]'`;

function wideOffsetCommitChanges(rows: CommitDateRow[]) {
  return rows
    .map((row) => ({
      row,
      authoredAt: normalizeOffsetTimestamp(row.authored_at),
      committedAt: normalizeOffsetTimestamp(row.committed_at),
    }))
    .filter(
      (change) =>
        change.authoredAt !== change.row.authored_at ||
        change.committedAt !== change.row.committed_at,
    );
}

/**
 * Finishes migration 0021 for the commit dates SQLite could not convert.
 *
 * 0021 rewrites `gh_commits.authored_at`/`committed_at` from offset form to UTC
 * with `strftime`, which returns NULL for an offset of +-15:00 or more, so its
 * COALESCE kept the original text. `toUtcIso` and `LocalApplier.applyRow` (both
 * `new Date(...).toISOString()`) accept offsets up to +-23:59, so a peer pulling
 * the same row stores UTC and two hosts would hold different text for one
 * instant. Real git never emits such an offset; it appears only in imported
 * history. JavaScript is the canonical form (it is what the collector and the
 * pull write), so this rewrites whatever 0021 left with the same function,
 * `normalizeOffsetTimestamp`, and one instant has one text on every host.
 *
 * Sync: like 0021, this is a pure function of the stored value, so every host
 * reaches the same text alone and nothing is pushed for it. `gh_commits_sync_update`
 * fires only while the stamp is unchanged, so each row's stamp is moved in the
 * same statement and put back in a second one (both are stamp changes, so
 * neither fires it). `sync_host` and `sync_dirty` are never written: a row
 * pushed before stays clean, a row not yet pushed stays dirty and goes out
 * normalized. A pull winning over such a row, or the reverse, compares equal
 * text under an equal stamp, so there is nothing to loop on.
 *
 * Runs once, as the TypeScript half of migration 0023 (`MIGRATION_STEPS`), inside
 * `applyMigrations`' IMMEDIATE transaction: the rewrite commits atomically with
 * the version bump, the migration lock serializes two processes, and every later
 * open costs nothing (it is never scanned for again). A backup restored from
 * below 23 reruns it. A value that ends in an offset but does not parse stays as
 * it is.
 */
function normalizeWideOffsetCommitDates(database: Database): void {
  const changes = wideOffsetCommitChanges(
    database.query(OFFSET_FORM_COMMITS).all() as CommitDateRow[],
  );
  const rewrite = database.query(
    "UPDATE gh_commits SET authored_at = ?, committed_at = ?, sync_updated_at = ? WHERE rowid = ?",
  );
  const restore = database.query("UPDATE gh_commits SET sync_updated_at = ? WHERE rowid = ?");
  for (const { row, authoredAt, committedAt } of changes) {
    // The marker is no stamp a real row holds (`...Z`), so it always differs.
    rewrite.run(authoredAt, committedAt, `${row.sync_updated_at ?? ""}~`, row.rowid);
    restore.run(row.sync_updated_at, row.rowid);
  }
}

/**
 * TypeScript halves of migrations, keyed by version. `applyMigrations` runs
 * each right after that migration's SQL, inside the same transaction, so a throw
 * rolls back the SQL, the step and the version bump together. For a rewrite SQL
 * cannot express exactly.
 */
const MIGRATION_STEPS: Readonly<Record<number, (database: Database) => void>> = {
  23: normalizeWideOffsetCommitDates,
};

/**
 * Runs `migrations` (ascending) and the `user_version` bump inside a single
 * transaction, so a failure part-way through leaves the database exactly as
 * it was before the first of them.
 *
 * Without this, a migration that dies on its fifth statement would leave the
 * first four applied and `user_version` un-bumped: the next start would replay
 * the whole file against a half-renamed schema, and whether that self-heals
 * depended on every residual statement happening to fail with one of the two
 * tolerated messages. That is recovery by coincidence; a transaction makes it
 * a property.
 *
 * `openDatabase` calls it once per migration below `TRIGGER_GATE_VERSION`
 * and once for every pending migration from it on. Recovery follows from
 * that: a failure below the gate keeps every earlier migration committed and
 * the next start resumes at the failed one; a failure anywhere from the gate
 * on rolls back the whole block, 0022 included, so the database stays at the
 * version below the block with the triggers that version had. A chain that
 * crosses the gate (18 to 23) commits 19, 20 and 21 one by one and then 22
 * and 23 together: below the gate every step keeps the triggers 0019
 * installed, so committing them separately opens no gap and keeps their
 * progress on a later failure, while the block from the gate is the stretch
 * whose intermediate commits would expose a database with no triggers.
 *
 * A migration's TypeScript half (`MIGRATION_STEPS`) runs right after its SQL,
 * inside the same transaction.
 *
 * With `reconcileTriggers`, `reconcileMirrorTriggers` runs once after the last
 * migration's SQL, before the version bump and the commit.
 *
 * SQLite runs DDL transactionally, so `ALTER TABLE`, `DROP TRIGGER` and
 * `PRAGMA user_version` all roll back with everything else.
 */
function applyMigrations(
  database: Database,
  migrations: readonly MigrationFile[],
  options: { reconcileTriggers: boolean },
): void {
  // IMMEDIATE takes the write lock up front (waiting out `busy_timeout`), and
  // the version is read again under it. `openDatabase` decided these
  // migrations were due from a read taken before the lock: a second process
  // (the w5 hook beside a CLI command) can have applied some or all of them in
  // between, and running one twice fails on the first `ADD COLUMN`. Only the
  // ones still above the version run; when none is, nothing changes.
  database.exec("BEGIN IMMEDIATE");
  try {
    const applied = userVersion(database);
    const due = migrations.filter((migration) => migration.version > applied);
    const last = due.at(-1);
    if (last === undefined) {
      database.exec("ROLLBACK");
      return;
    }
    for (const migration of due) {
      runMigration(database, migration.sql);
      MIGRATION_STEPS[migration.version]?.(database);
    }
    if (options.reconcileTriggers) reconcileMirrorTriggers(database);
    database.exec(`PRAGMA user_version = ${last.version};`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Some tables (`traces`, `stints`, `quests`) are projection tables
 * created lazily by `ensureTables` (`src/intent/projections/index.ts`), not
 * by a migration -- so an `ALTER TABLE ... ADD COLUMN` targeting one of them
 * fails with "no such table" on a database where the intent layer was never
 * used. That's fine: the projection's own `createSql` already includes the
 * column for any table it creates from scratch, so skipping the ALTER here
 * is a no-op, not data loss.
 *
 * Only migration files that consist solely of such statements go through
 * this per-statement, tolerant path; every other migration (some of which
 * define triggers whose bodies contain their own semicolons, e.g.
 * 0003_events.sql) still runs as one plain `exec` so its statements are
 * never split apart.
 *
 * The tolerance is deliberately narrow, and covers exactly three messages:
 *
 * - "no such table" -- 0006, 0007, 0010 and 0011 target projection tables that
 *   a never-used intent layer has not created yet.
 * - "no such column" -- 0011's `RENAME COLUMN`s target columns that a
 *   freshly-created projection table already has under the new name.
 * - "duplicate column name" -- an `ADD COLUMN` re-applied to a table that was
 *   built (by an earlier `openDatabase` call in the same test/process, at a
 *   pinned lower `user_version`) from schema that already includes the
 *   column: the column is already there, so adding it again is a no-op.
 *
 * Every other error propagates and rolls the whole migration back
 * (see `applyMigrations`). Skipping is safe only because these statements are
 * idempotent with respect to a table the projection creates correctly from
 * scratch; it is not a general "ignore migration errors" path.
 */
function runMigration(database: Database, sql: string): void {
  const statements = sql
    .split(";")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement.length > 0);
  const allTolerableAlter = statements.every((statement) =>
    /^ALTER TABLE \S+ (ADD COLUMN|DROP COLUMN|RENAME (TO|COLUMN))/i.test(statement),
  );

  if (!allTolerableAlter) {
    database.exec(sql);
    return;
  }

  for (const statement of statements) {
    try {
      database.exec(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("no such table") ||
        message.includes("no such column") ||
        message.includes("duplicate column name")
      )
        continue;
      throw error;
    }
  }
}
