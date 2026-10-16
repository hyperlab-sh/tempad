import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import { ulidAfter } from "../intent/ids";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

function loadMigrations(): { version: number; sql: string }[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  return files.map((file) => {
    const match = file.match(/^(\d+)_/);
    if (!match?.[1]) {
      throw new Error(`Migration file name must start with a number: ${file}`);
    }
    return {
      version: Number.parseInt(match[1], 10),
      sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
    };
  });
}

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
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  const database = new Database(path);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");

  const currentVersion = (database.query("PRAGMA user_version;").get() as { user_version: number })
    .user_version;

  const migrations = loadMigrations();
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    if (options.upToVersion !== undefined && migration.version > options.upToVersion) break;
    applyMigration(database, migration);
  }

  if (hasColumn(database, "events", "uid")) backfillEventUids(database);
  if (options.hostSlug !== undefined && hasTable(database, "sync_local")) {
    database
      .query(
        "INSERT INTO sync_local (id, host_slug) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET host_slug = excluded.host_slug WHERE host_slug IS NOT excluded.host_slug",
      )
      .run(options.hostSlug);
  }

  return database;
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

/**
 * Gives every event without a `uid` one, once: rows written before migration
 * 0019 (or inserted by hand, outside `EventStore`, since). Rows are walked in
 * `id` order through a single monotonic ULID factory seeded with each row's
 * `recorded_at`. The factory never goes backwards -- a seed at or before the
 * last one reuses the last time and increments the random half -- so the
 * uids sort exactly like the ids, even where `recorded_at` is not monotonic in
 * `id`, and replaying `ORDER BY uid` reproduces the old `ORDER BY id`.
 *
 * Seeding from `recorded_at` keeps legacy uids below every uid appended later
 * (`EventStore.append` also refuses to go below the current maximum), so the
 * single-host order stays insertion order across the upgrade.
 *
 * `uid IS NULL` is answered from the `events_uid` index, so this is a cheap
 * no-op on every open after the first.
 */
function backfillEventUids(database: Database): void {
  const rows = database
    .query("SELECT id, recorded_at FROM events WHERE uid IS NULL ORDER BY id")
    .all() as { id: number; recorded_at: string }[];
  if (rows.length === 0) return;

  // Never start below an existing uid: a row inserted by hand after the
  // migration must still sort after the events already carrying one.
  const maximum = (
    database.query("SELECT MAX(uid) AS uid FROM events").get() as {
      uid: string | null;
    }
  ).uid;
  const nextUid = monotonicFactory();
  const update = database.query("UPDATE events SET uid = ? WHERE id = ?");
  const run = database.transaction(() => {
    let previous = maximum;
    for (const row of rows) {
      const seed = Date.parse(row.recorded_at);
      if (Number.isNaN(seed)) {
        throw new Error(`events row ${row.id} has an unparseable recorded_at: ${row.recorded_at}`);
      }
      const uid = ulidAfter(nextUid(seed), previous);
      update.run(uid, row.id);
      previous = uid;
    }
  });
  run();
}

/**
 * Runs one migration and its `user_version` bump inside a single transaction,
 * so a failure part-way through leaves the database exactly as it was.
 *
 * Without this, a migration that dies on its fifth statement would leave the
 * first four applied and `user_version` un-bumped: the next start would replay
 * the whole file against a half-renamed schema, and whether that self-heals
 * depended on every residual statement happening to fail with one of the two
 * tolerated messages. That is recovery by coincidence; a transaction makes it
 * a property.
 *
 * SQLite runs DDL transactionally, so `ALTER TABLE` and `PRAGMA user_version`
 * both roll back with everything else.
 */
function applyMigration(database: Database, migration: { version: number; sql: string }): void {
  database.exec("BEGIN");
  try {
    runMigration(database, migration.sql);
    database.exec(`PRAGMA user_version = ${migration.version};`);
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
 * (see `applyMigration`). Skipping is safe only because these statements are
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
