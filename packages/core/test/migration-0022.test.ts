import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import * as migrationFiles from "../src/db/migration-files.ts";
import { dailyReport } from "../src/report/daily.ts";
import { hourlyReport } from "../src/report/hourly.ts";
import { projectReport } from "../src/report/project.ts";
import { weeklyReport } from "../src/report/weekly.ts";
import { runSyncEngine } from "../src/sync/engine.ts";
import { SYNCED_UPSERT_TABLES } from "../src/sync/tables.ts";
import * as triggers from "../src/sync/triggers.ts";
import {
  enableMirrorSync,
  ensureMirrorTriggers,
  isMirrorSyncEnabled,
  MIRROR_SYNC_ENABLED,
  MIRROR_TRIGGER_NAMES,
  mirrorTriggerDefinitions,
} from "../src/sync/triggers.ts";
import { REPORT_CONFIG, seedReportFixtures } from "./fixtures/report-golden/seed.ts";
import { addCommit, addRepository, FakeRemote, restamp } from "./sync/helpers.ts";

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PUSHED_STAMP = "2026-01-01T00:00:00.000Z";

/** The real chain up to 0022: tests that stand in for later migrations append their own after it. */
function chainThrough22() {
  return migrationFiles.loadMigrations().filter((migration) => migration.version <= 22);
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "tempad-migration-0022-"));
}

function withDirectory(run: (path: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const directory = temporaryDirectory();
    try {
      await run(join(directory, "tempad.db"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function userVersion(database: Database): number {
  return (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** Name -> stored SQL of every mirror trigger present. */
function installedTriggers(database: Database): Record<string, string> {
  const rows = database
    .query(
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${MIRROR_TRIGGER_NAMES.map(() => "?").join(", ")}) ORDER BY name`,
    )
    .all(...MIRROR_TRIGGER_NAMES) as { name: string; sql: string }[];
  return Object.fromEntries(rows.map((row) => [row.name, row.sql]));
}

function expectedTriggers(): Record<string, string> {
  return Object.fromEntries([...mirrorTriggerDefinitions()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** One row in each of the six mirrors, parents first, as the collectors write them. */
function seedMirrors(database: Database, suffix = ""): void {
  database.exec(`
    INSERT INTO gh_repos (full_name, org, is_personal, default_branch, project, meta)
      VALUES ('acme/widgets${suffix}', 'acme', 0, 'main', 'widgets', NULL);
    INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
      VALUES ('abc123${suffix}', 'acme/widgets${suffix}', '["main"]', 'S', 's@x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'fix it', NULL, 1, 2, 3);
    INSERT INTO gh_pull_requests (repo, number, title, state, author, role, created_at, merged_at, closed_at)
      VALUES ('acme/widgets${suffix}', 44, 'Fix it', 'open', 's', 'author', '2026-01-01T00:00:00Z', NULL, NULL);
    INSERT INTO monday_items (id, board_id, board_name, group_name, name, status, assignees, timeline_start, timeline_end, time_tracked_seconds, created_at, updated_at, raw, org, project, meta)
      VALUES (7${suffix === "" ? "" : "1"}, 1, 'Board', NULL, 'item', NULL, '[]', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{}', 'acme', 'widgets', NULL);
    INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
      VALUES ('s1${suffix}', '~/.claude', 'dir', '/tmp/s1.jsonl', NULL, 'acme', 'widgets', NULL, 'a title', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 0, '[]', 'host-a', '2026-01-01T00:00:00Z');
    INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, origin_kind, model, text_preview, tool_name, tokens_in, tokens_out)
      VALUES ('m1${suffix}', 's1${suffix}', '2026-01-01T00:00:00Z', 'user', 0, 'human', NULL, 'hi', NULL, NULL, NULL);
  `);
}

/** The same content change on every mirror, then two deletes and a re-insert. */
function churn(database: Database): void {
  database.exec(`
    UPDATE gh_repos SET default_branch = 'trunk';
    UPDATE gh_commits SET subject = 'fix it properly';
    UPDATE gh_pull_requests SET state = 'merged';
    UPDATE monday_items SET status = 'Done';
    UPDATE claude_sessions SET title = 'renamed';
    UPDATE claude_messages SET text_preview = 'edited';
    DELETE FROM gh_pull_requests WHERE number = 44;
    DELETE FROM gh_commits WHERE sha = 'abc123';
    INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
      VALUES ('abc123', 'acme/widgets', '["main"]', 'S', 's@x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'back', NULL, 1, 2, 3);
  `);
}

interface SyncState {
  mirrors: Record<string, Record<string, unknown>[]>;
  tombstones: Record<string, unknown>[];
}

/**
 * Every mirror's sync columns keyed by its natural key, and every tombstone.
 * With `normalize`, a stamp shows as `<stamp>` once checked to be one, so two
 * databases written at different instants compare equal.
 */
function syncState(database: Database, normalize = false): SyncState {
  const stamp = (value: unknown) => {
    if (!normalize) return value;
    expect(value).toMatch(STAMP);
    return "<stamp>";
  };
  const mirrors: SyncState["mirrors"] = {};
  for (const table of SYNCED_UPSERT_TABLES) {
    const key = table.keyColumns.join(", ");
    mirrors[table.name] = (
      database
        .query(
          `SELECT ${key}, sync_host, sync_updated_at, sync_dirty FROM ${table.name} ORDER BY ${key}`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({ ...row, sync_updated_at: stamp(row.sync_updated_at) }));
  }
  const tombstones = (
    database
      .query(
        "SELECT tbl, pk, deleted_at, sync_host, sync_dirty FROM sync_tombstones ORDER BY tbl, pk",
      )
      .all() as Record<string, unknown>[]
  ).map((row) => ({ ...row, deleted_at: stamp(row.deleted_at) }));
  return { mirrors, tombstones };
}

function eventSyncState(database: Database): unknown[] {
  return database.query("SELECT id, uid, sync_host, sync_dirty FROM events ORDER BY id").all();
}

let eventCounter = 0;

/** An event with its uid set, as `EventStore.append` writes it at 0021. */
function insertEvent(database: Database, subject: string): void {
  eventCounter += 1;
  database
    .query(
      "INSERT INTO events (uid, at, recorded_at, actor, kind, subject, payload) VALUES (?, '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z', 'hero', 'hero.created', ?, '{}')",
    )
    .run(`01K00000000000000000000${String(eventCounter).padStart(3, "0")}`, subject);
}

/** Holds the write lock on `path` from a second connection until released. */
function holdWriteLock(path: string): Database {
  const writer = openDatabase(path);
  writer.exec("BEGIN IMMEDIATE");
  writer.query("INSERT INTO sync_meta (key, value) VALUES ('probe', 'held')").run();
  return writer;
}

describe("migration 0022: mirror triggers only where sync has run", () => {
  test("mirror-triggers.sql is exactly what 0019 installed, so an enabled database sees no drift", () => {
    const old = openDatabase(":memory:", { upToVersion: 21 });
    expect(installedTriggers(old)).toEqual(expectedTriggers());
    expect(Object.keys(expectedTriggers())).toHaveLength(18);
    old.close();
  });

  test("a fresh database has no mirror triggers: no stamps, no tombstones", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    expect(userVersion(database)).toBe(25);
    expect(isMirrorSyncEnabled(database)).toBe(false);
    expect(installedTriggers(database)).toEqual({});

    seedMirrors(database);
    churn(database);
    for (const rows of Object.values(syncState(database).mirrors)) {
      for (const row of rows) {
        expect(row.sync_updated_at).toBeNull();
        expect(row.sync_host).toBeNull();
        expect(row.sync_dirty).toBe(1);
      }
    }
    expect(syncState(database).tombstones).toEqual([]);
    database.close();
  });

  test(
    "a never-synced 0021 database loses its triggers and its tombstones, and keeps its rows as they were",
    withDirectory((path) => {
      const old = openDatabase(path, { upToVersion: 21, hostSlug: "host-a" });
      seedMirrors(old);
      churn(old);
      insertEvent(old, "H1");
      const before = syncState(old);
      expect(before.tombstones.length).toBe(2);
      const events = eventSyncState(old);
      old.close();

      const database = openDatabase(path, { hostSlug: "host-a" });
      expect(userVersion(database)).toBe(25);
      expect(isMirrorSyncEnabled(database)).toBe(false);
      expect(installedTriggers(database)).toEqual({});
      expect(syncState(database)).toEqual({ ...before, tombstones: [] });
      expect(eventSyncState(database)).toEqual(events);
      database.close();
    }),
  );

  for (const [label, markSynced] of [
    [
      "server_id in sync_meta",
      (database: Database) =>
        database.exec("INSERT INTO sync_meta (key, value) VALUES ('server_id', 'S1')"),
    ],
    [
      "a pull cursor",
      (database: Database) =>
        database.exec("INSERT INTO sync_cursors (stream, seq) VALUES ('rows', 3)"),
    ],
    [
      "a pushed event",
      (database: Database) =>
        database.exec("UPDATE events SET sync_dirty = 0 WHERE subject = 'H1'"),
    ],
    [
      "a pushed mirror row",
      (database: Database) =>
        database.exec(
          `UPDATE claude_messages SET sync_dirty = 0, sync_host = 'host-a', sync_updated_at = '${PUSHED_STAMP}'`,
        ),
    ],
  ] as const) {
    test(
      `an already-synced 0021 database (${label}) keeps its triggers and every pending row, event and tombstone`,
      withDirectory((path) => {
        const old = openDatabase(path, { upToVersion: 21, hostSlug: "host-a" });
        seedMirrors(old);
        insertEvent(old, "H1");
        insertEvent(old, "H2");
        // Some rows pushed, the rest still pending; one pending tombstone.
        old.exec(
          `UPDATE gh_repos SET sync_dirty = 0, sync_host = 'host-a', sync_updated_at = '${PUSHED_STAMP}'`,
        );
        old.exec("DELETE FROM gh_pull_requests WHERE number = 44");
        markSynced(old);
        const before = syncState(old);
        const events = eventSyncState(old);
        const triggers = installedTriggers(old);
        expect(before.tombstones).toHaveLength(1);
        old.close();

        const database = openDatabase(path, { hostSlug: "host-a" });
        expect(userVersion(database)).toBe(25);
        expect(isMirrorSyncEnabled(database)).toBe(true);
        expect(installedTriggers(database)).toEqual(triggers);
        expect(syncState(database)).toEqual(before);
        expect(eventSyncState(database)).toEqual(events);
        database.close();
      }),
    );
  }

  test(
    "pending rows of an already-synced 0021 database are pushed after 0022",
    withDirectory(async (path) => {
      const old = openDatabase(path, { upToVersion: 21, hostSlug: "host-a" });
      seedMirrors(old);
      old.exec("DELETE FROM gh_pull_requests WHERE number = 44");
      old.exec("INSERT INTO sync_meta (key, value) VALUES ('reseed_pending', 'S1')");
      old.close();

      const database = openDatabase(path, { hostSlug: "host-a" });
      const remote = new FakeRemote();
      const summary = await runSyncEngine(database, remote, {
        hostSlug: "host-a",
        batchSize: 50,
        push: true,
        pull: false,
      });
      // Five mirror rows (the PR was deleted) and its tombstone.
      expect(summary.pushed).toEqual({ events: 0, rows: 5, tombstones: 1 });
      expect(
        database.query("SELECT COUNT(*) AS n FROM gh_commits WHERE sync_dirty = 1").get(),
      ).toEqual({ n: 0 });
      database.close();
    }),
  );
});

describe("enableMirrorSync", () => {
  test("stamps, tags and dirties rows written while sync was off, once, and installs the triggers", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    churn(database);

    const before = Date.now();
    expect(enableMirrorSync(database)).toBe(true);
    expect(isMirrorSyncEnabled(database)).toBe(true);
    expect(installedTriggers(database)).toEqual(expectedTriggers());
    const state = syncState(database);
    // churn deleted the only pull request; every other mirror holds rows.
    expect(state.mirrors.gh_pull_requests).toEqual([]);
    for (const rows of Object.values(state.mirrors)) {
      for (const row of rows) {
        expect(row.sync_updated_at).toMatch(STAMP);
        expect(Date.parse(row.sync_updated_at as string)).toBeGreaterThanOrEqual(before - 1);
        expect(row.sync_host).toBe("host-a");
        expect(row.sync_dirty).toBe(1);
      }
    }
    // Deleted while off: nothing remote ever held them.
    expect(state.tombstones).toEqual([]);

    // A second call changes nothing.
    expect(enableMirrorSync(database)).toBe(false);
    expect(syncState(database)).toEqual(state);
    database.close();
  });

  test("restamps a row 0019 already stamped as written now, and never moves a stamp backwards", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    database.exec(`UPDATE gh_commits SET sync_updated_at = '${PUSHED_STAMP}'`);
    database.exec("UPDATE gh_repos SET sync_updated_at = '2099-01-01T00:00:00.000Z'");
    const before = new Date().toISOString();
    enableMirrorSync(database);
    const commit = database
      .query("SELECT sync_updated_at, sync_host, sync_dirty FROM gh_commits")
      .get() as { sync_updated_at: string; sync_host: string; sync_dirty: number };
    expect(commit.sync_updated_at >= before).toBe(true);
    expect(commit).toMatchObject({ sync_host: "host-a", sync_dirty: 1 });
    // A stamp ahead of the clock moves on by one millisecond, as the triggers do.
    expect(database.query("SELECT sync_updated_at FROM gh_repos").get()).toEqual({
      sync_updated_at: "2099-01-01T00:00:00.001Z",
    });
    database.close();
  });

  test(
    "a row changed while sync was off beats an older version another host pushed after its 0019 stamp",
    withDirectory(async (path) => {
      const options = { batchSize: 50, push: true, pull: true };
      // Host A, v21 era: the commit is collected and stamped Sept 1.
      const oldA = openDatabase(path, { upToVersion: 21, hostSlug: "host-a" });
      addRepository(oldA, "acme/widgets");
      addCommit(oldA, "abc123", "acme/widgets", "first version");
      restamp(oldA, "gh_commits", "sha = ?", ["abc123"], "2026-09-01T00:00:00.000Z");
      oldA.close();
      // 0022 drops A's triggers; the collector changes the subject (Oct 5) and
      // the Sept 1 stamp stays.
      const hostA = openDatabase(path, { hostSlug: "host-a" });
      addCommit(hostA, "abc123", "acme/widgets", "newer on A");
      expect(
        hostA.query("SELECT sync_updated_at FROM gh_commits WHERE sha = 'abc123'").get(),
      ).toEqual({ sync_updated_at: "2026-09-01T00:00:00.000Z" });

      // Host B pushes older content for the same sha, stamped Oct 1.
      const remote = new FakeRemote();
      const hostB = openDatabase(":memory:", { hostSlug: "host-b" });
      addRepository(hostB, "acme/widgets");
      addCommit(hostB, "abc123", "acme/widgets", "older on B");
      await runSyncEngine(hostB, remote, { ...options, hostSlug: "host-b" });
      restamp(hostB, "gh_commits", "sha = ?", ["abc123"], "2026-10-01T00:00:00.000Z");
      await runSyncEngine(hostB, remote, { ...options, hostSlug: "host-b" });

      // A's first sync, then B's next one: A's content wins on both.
      await runSyncEngine(hostA, remote, { ...options, hostSlug: "host-a" });
      await runSyncEngine(hostB, remote, { ...options, hostSlug: "host-b" });
      for (const database of [hostA, hostB]) {
        expect(
          database.query("SELECT subject, sync_host FROM gh_commits WHERE sha = 'abc123'").get(),
        ).toEqual({ subject: "newer on A", sync_host: "host-a" });
      }
      hostA.close();
      hostB.close();
    }),
  );

  test("with sync on, inserts, updates and deletes stamp and tombstone exactly as the ungated 0021 triggers did", () => {
    const ungated = openDatabase(":memory:", { upToVersion: 21, hostSlug: "host-a" });
    const gated = openDatabase(":memory:", { hostSlug: "host-a" });
    enableMirrorSync(gated);
    for (const database of [ungated, gated]) {
      seedMirrors(database);
      // As a pull from another host leaves a row: explicit stamp, clean.
      database.exec(
        `INSERT INTO gh_repos (full_name, org, is_personal, sync_host, sync_updated_at, sync_dirty)
           VALUES ('acme/pulled', 'acme', 0, 'host-b', '${PUSHED_STAMP}', 0)`,
      );
      // Marking a row pushed must not restamp it.
      database.exec("UPDATE claude_messages SET sync_dirty = 0");
      churn(database);
      seedMirrors(database, "-2");
      database.exec("DELETE FROM claude_messages WHERE uuid = 'm1-2'");
    }
    const expected = syncState(ungated, true);
    expect(expected.tombstones).toHaveLength(3);
    expect(syncState(gated, true)).toEqual(expected);
    ungated.close();
    gated.close();
  });

  test("the first sync run enables it; a row deleted before then is not pushed as a tombstone", async () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    database.exec("DELETE FROM gh_pull_requests WHERE number = 44");
    const remote = new FakeRemote();
    const summary = await runSyncEngine(database, remote, {
      hostSlug: "host-a",
      batchSize: 50,
      push: true,
      pull: true,
    });
    expect(isMirrorSyncEnabled(database)).toBe(true);
    expect(summary.pushed).toEqual({ events: 0, rows: 5, tombstones: 0 });
    expect(
      remote.database.query("SELECT COUNT(*) AS n FROM sync_rows WHERE data IS NULL").get(),
    ).toEqual({ n: 0 });

    // From now on a delete is a tombstone and is pushed.
    database.exec("DELETE FROM gh_commits WHERE sha = 'abc123'");
    const next = await runSyncEngine(database, remote, {
      hostSlug: "host-a",
      batchSize: 50,
      push: true,
      pull: true,
    });
    expect(next.pushed.tombstones).toBe(1);
    database.close();
  });
});

describe("openDatabase keeps the triggers matching the marker", () => {
  test(
    "a dropped or edited mirror trigger is put back from mirror-triggers.sql on open",
    withDirectory((path) => {
      const first = openDatabase(path, { hostSlug: "host-a" });
      enableMirrorSync(first);
      first.exec("DROP TRIGGER gh_commits_sync_delete");
      first.exec("DROP TRIGGER gh_repos_sync_insert");
      first.exec(
        "CREATE TRIGGER gh_repos_sync_insert AFTER INSERT ON gh_repos BEGIN SELECT 1; END",
      );
      first.close();

      const reopened = openDatabase(path);
      expect(installedTriggers(reopened)).toEqual(expectedTriggers());
      reopened.close();
    }),
  );

  test(
    "mirror triggers on a database without the marker are dropped on open",
    withDirectory((path) => {
      const first = openDatabase(path);
      enableMirrorSync(first);
      first.query("DELETE FROM sync_meta WHERE key = ?").run(MIRROR_SYNC_ENABLED);
      first.close();

      const reopened = openDatabase(path);
      expect(installedTriggers(reopened)).toEqual({});
      reopened.close();
    }),
  );

  for (const enabled of [false, true]) {
    test(
      `an unchanged database (sync ${enabled ? "on" : "off"}) opens without writing while another connection holds the lock`,
      withDirectory((path) => {
        const first = openDatabase(path, { hostSlug: "host-a" });
        if (enabled) enableMirrorSync(first);
        first.close();
        const writer = holdWriteLock(path);
        try {
          const reader = openDatabase(path, { hostSlug: "host-a", busyTimeoutMs: 300 });
          expect(Object.keys(installedTriggers(reader))).toHaveLength(enabled ? 18 : 0);
          reader.close();
        } finally {
          writer.exec("ROLLBACK");
          writer.close();
        }
      }),
    );
  }
});

describe("offline report output", () => {
  const render = (database: Database): string[] => {
    const range = { from: "2026-08-31", to: "2026-09-02" };
    return [
      dailyReport.render(database, REPORT_CONFIG, range),
      hourlyReport.render(database, REPORT_CONFIG, range),
      projectReport.render(database, REPORT_CONFIG, range),
      weeklyReport.render(database, REPORT_CONFIG, range),
    ];
  };

  test(
    "with sync off, every report is byte-identical before and after 0022",
    withDirectory((path) => {
      const old = openDatabase(path, { upToVersion: 21, hostSlug: "test-host" });
      seedReportFixtures(old);
      const before = render(old);
      expect(before.join("").length).toBeGreaterThan(0);
      old.close();

      // Stops at 23: the report fixture inserts quest rows by hand with no
      // events behind them, and 0024's step re-projects quests from events.
      const migrated = openDatabase(path, { upToVersion: 23, hostSlug: "test-host" });
      expect(userVersion(migrated)).toBe(23);
      expect(render(migrated)).toEqual(before);
      migrated.close();

      // The same data written with the triggers absent renders the same too.
      const fresh = openDatabase(":memory:", { hostSlug: "test-host" });
      seedReportFixtures(fresh);
      expect(isMirrorSyncEnabled(fresh)).toBe(false);
      expect(render(fresh)).toEqual(before);
      fresh.close();
    }),
  );
});

/**
 * Runs `sql` in another process inside `BEGIN IMMEDIATE`, holding the write
 * lock for `holdMs` before it commits. Resolves once the lock is held, with a
 * promise for the child's exit. Another process, because the race under test
 * is between a read taken before the lock and the write that waits for it:
 * one thread cannot commit while it is blocked waiting.
 */
async function commitFromAnotherProcess(
  path: string,
  sql: string,
  holdMs: number,
): Promise<{ exited: Promise<number> }> {
  const code = `
    import { Database } from "bun:sqlite";
    const database = new Database(${JSON.stringify(path)});
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN IMMEDIATE");
    database.exec(${JSON.stringify(sql)});
    console.log("ready");
    Bun.sleepSync(${holdMs});
    database.exec("COMMIT");
    database.close();
  `;
  const child = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`child exited before taking the lock: ${output}`);
    output += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return { exited: child.exited };
}

/** A raw connection: `openDatabase` would itself reconcile the triggers. */
function rawConnection(path: string): Database {
  const database = new Database(path);
  database.exec("PRAGMA busy_timeout = 5000");
  return database;
}

const SET_MARKER = `INSERT INTO sync_meta (key, value) VALUES ('${MIRROR_SYNC_ENABLED}', 'other process')`;

describe("races with another process", () => {
  test(
    "ensureMirrorTriggers re-plans under the lock: an enable committed after its first look keeps the triggers",
    withDirectory(async (path) => {
      // Triggers installed, marker gone: a plan made now drops all 18.
      const setup = openDatabase(path);
      enableMirrorSync(setup);
      setup.query("DELETE FROM sync_meta WHERE key = ?").run(MIRROR_SYNC_ENABLED);
      setup.close();

      const reader = rawConnection(path);
      const other = await commitFromAnotherProcess(path, SET_MARKER, 400);
      ensureMirrorTriggers(reader);
      expect(await other.exited).toBe(0);
      expect(isMirrorSyncEnabled(reader)).toBe(true);
      expect(installedTriggers(reader)).toEqual(expectedTriggers());
      reader.close();
    }),
  );

  test(
    "enableMirrorSync re-checks the marker under the lock: losing the race is a no-op, not a UNIQUE error",
    withDirectory(async (path) => {
      openDatabase(path).close();
      const loser = rawConnection(path);
      const other = await commitFromAnotherProcess(path, SET_MARKER, 400);
      expect(enableMirrorSync(loser)).toBe(false);
      expect(await other.exited).toBe(0);
      expect(
        loser.query("SELECT value FROM sync_meta WHERE key = ?").get(MIRROR_SYNC_ENABLED),
      ).toEqual({ value: "other process" });
      loser.close();
    }),
  );
});

describe("reconcile runs once per upgrade", () => {
  test(
    "reconcile runs once, at the end of the block from 22, and an unchanged reopen not at all",
    withDirectory((path) => {
      const old = openDatabase(path, { upToVersion: 21, hostSlug: "host-a" });
      seedMirrors(old);
      old.exec("INSERT INTO sync_meta (key, value) VALUES ('server_id', 'S1')");
      old.close();

      // Two future migrations past 22; the one at 23 updates a mirror.
      const chain = [
        ...chainThrough22(),
        { version: 23, sql: "UPDATE gh_commits SET subject = subject || ' (23)';" },
        { version: 24, sql: "SELECT 1;" },
      ];
      const load = spyOn(migrationFiles, "loadMigrations").mockImplementation(() => chain);
      const original = triggers.reconcileMirrorTriggers;
      const versionsAtReconcile: number[] = [];
      const reconcile = spyOn(triggers, "reconcileMirrorTriggers").mockImplementation(
        (database) => {
          versionsAtReconcile.push(userVersion(database));
          original(database);
        },
      );
      try {
        const upgraded = openDatabase(path, { hostSlug: "host-a" });
        expect(userVersion(upgraded)).toBe(24);
        // Once, after 24's SQL, in the transaction that began at 21: nothing
        // from 22 on is committed until the reconcile has run.
        expect(versionsAtReconcile).toEqual([21]);
        expect(installedTriggers(upgraded)).toEqual(expectedTriggers());
        upgraded.close();

        openDatabase(path, { hostSlug: "host-a" }).close();
        expect(reconcile).toHaveBeenCalledTimes(1);
      } finally {
        reconcile.mockRestore();
        load.mockRestore();
      }
    }),
  );
});

/** What another connection sees while the upgrading one is inside a migration. */
interface Observation {
  userVersion: number;
  triggers: Record<string, string>;
  write: "blocked" | "committed";
}

/**
 * Looks at `path` from a second connection, as a w5 hook or a collector with
 * the database already open would: the committed version and triggers (a WAL
 * reader never waits on the writer), then a mirror insert with a 50 ms busy
 * timeout. A write that commits here, while the triggers are gone, is never
 * stamped or tombstoned, so it would never push.
 */
function observeFromAnotherConnection(path: string): Observation {
  const other = new Database(path);
  other.exec("PRAGMA busy_timeout = 50");
  try {
    const observation: Observation = {
      userVersion: userVersion(other),
      triggers: installedTriggers(other),
      write: "committed",
    };
    try {
      other
        .query(
          "INSERT INTO gh_repos (full_name, org, is_personal, default_branch, project, meta) VALUES ('acme/during-upgrade', 'acme', 0, 'main', 'during', NULL)",
        )
        .run();
    } catch (error) {
      expect(String(error)).toMatch(/locked|busy/i);
      observation.write = "blocked";
    }
    return observation;
  } finally {
    other.close();
  }
}

/**
 * A future migration whose SQL is read inside the upgrading transaction (the
 * runner reads `sql` only once it holds the write lock), so its getter runs
 * `observe` after 0022's statements and before the reconcile and commit.
 */
function observedMigration(version: number, sql: string, observe: () => void) {
  return {
    version,
    get sql() {
      observe();
      return sql;
    },
  };
}

describe("migrations from 22 on apply as one transaction", () => {
  test(
    "no commit lands between 0022 and the reconcile: another connection sees v21 with every trigger, and cannot write",
    withDirectory((path) => {
      const old = openDatabase(path, { upToVersion: 21, hostSlug: "host-a" });
      seedMirrors(old);
      old.exec("INSERT INTO sync_meta (key, value) VALUES ('server_id', 'S1')");
      old.close();

      const observations: Observation[] = [];
      const chain = [
        ...chainThrough22(),
        observedMigration(24, "UPDATE gh_commits SET subject = subject || ' (23)';", () =>
          observations.push(observeFromAnotherConnection(path)),
        ),
      ];
      const load = spyOn(migrationFiles, "loadMigrations").mockImplementation(() => chain);
      try {
        const upgraded = openDatabase(path, { hostSlug: "host-a" });
        expect(observations.length).toBeGreaterThan(0);
        for (const observation of observations) {
          expect(observation).toEqual({
            userVersion: 21,
            triggers: expectedTriggers(),
            write: "blocked",
          });
        }
        expect(userVersion(upgraded)).toBe(24);
        expect(installedTriggers(upgraded)).toEqual(expectedTriggers());
        expect(
          upgraded.query("SELECT 1 FROM gh_repos WHERE full_name = 'acme/during-upgrade'").get(),
        ).toBeNull();
        // 0024's update ran with the triggers installed: stamped, tagged, dirty.
        expect(
          upgraded.query("SELECT subject, sync_host, sync_dirty FROM gh_commits").all(),
        ).toEqual([{ subject: "fix it (23)", sync_host: "host-a", sync_dirty: 1 }]);
        upgraded.close();
      } finally {
        load.mockRestore();
      }
    }),
  );

  test(
    "a failing later migration rolls 0022 back too: the database stays at v21 with its triggers and no marker",
    withDirectory((path) => {
      const old = openDatabase(path, { upToVersion: 21, hostSlug: "host-a" });
      seedMirrors(old);
      old.exec("INSERT INTO sync_meta (key, value) VALUES ('server_id', 'S1')");
      const before = syncState(old);
      old.close();

      const chain = [...chainThrough22(), { version: 24, sql: "UPDATE no_such_table SET x = 1;" }];
      const load = spyOn(migrationFiles, "loadMigrations").mockImplementation(() => chain);
      try {
        expect(() => openDatabase(path, { hostSlug: "host-a" })).toThrow(/no such table/);
      } finally {
        load.mockRestore();
      }

      const raw = rawConnection(path);
      expect(userVersion(raw)).toBe(21);
      expect(installedTriggers(raw)).toEqual(expectedTriggers());
      expect(isMirrorSyncEnabled(raw)).toBe(false);
      expect(syncState(raw)).toEqual(before);
      raw.close();

      // The real chain still upgrades it afterwards.
      const upgraded = openDatabase(path, { hostSlug: "host-a" });
      expect(userVersion(upgraded)).toBe(25);
      expect(isMirrorSyncEnabled(upgraded)).toBe(true);
      expect(installedTriggers(upgraded)).toEqual(expectedTriggers());
      upgraded.close();
    }),
  );

  test(
    "a chain that crosses 22 keeps the steps below 22 when the block from 22 fails",
    withDirectory((path) => {
      openDatabase(path, { upToVersion: 18 }).close();

      const chain = [...chainThrough22(), { version: 24, sql: "UPDATE no_such_table SET x = 1;" }];
      const load = spyOn(migrationFiles, "loadMigrations").mockImplementation(() => chain);
      try {
        expect(() => openDatabase(path)).toThrow(/no such table/);
      } finally {
        load.mockRestore();
      }

      const raw = rawConnection(path);
      // 19, 20 and 21 committed one by one; 22, 23 and 24 rolled back as one.
      expect(userVersion(raw)).toBe(21);
      expect(installedTriggers(raw)).toEqual(expectedTriggers());
      raw.close();
    }),
  );

  test(
    "a second process that already applied part of the block: only the rest runs, reconciled once",
    withDirectory((path) => {
      const old = openDatabase(path, { upToVersion: 21, hostSlug: "host-a" });
      seedMirrors(old);
      old.exec("INSERT INTO sync_meta (key, value) VALUES ('server_id', 'S1')");
      old.close();

      // 24 fails if it runs twice, so re-running what the other process
      // already applied would throw (CREATE TABLE, not ADD COLUMN, which
      // runMigration tolerates as a duplicate).
      const chain = [
        ...chainThrough22(),
        { version: 24, sql: "CREATE TABLE t23 (x);" },
        { version: 25, sql: "CREATE TABLE t24 (x);" },
      ];
      // Another process got 22 through 24 in after this one read user_version 21.
      const load = spyOn(migrationFiles, "loadMigrations").mockImplementation(() => {
        load.mockImplementation(() => chain);
        openDatabase(path, { hostSlug: "host-a", upToVersion: 24 }).close();
        return chain;
      });
      const original = triggers.reconcileMirrorTriggers;
      const reconcile = spyOn(triggers, "reconcileMirrorTriggers").mockImplementation((database) =>
        original(database),
      );
      try {
        const upgraded = openDatabase(path, { hostSlug: "host-a" });
        expect(userVersion(upgraded)).toBe(25);
        // Once at the end of the other process's 22..24, once here after 25.
        expect(reconcile).toHaveBeenCalledTimes(2);
        expect(installedTriggers(upgraded)).toEqual(expectedTriggers());
        expect(
          upgraded
            .query(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('t23', 't24') ORDER BY name",
            )
            .all(),
        ).toEqual([{ name: "t23" }, { name: "t24" }]);
        upgraded.close();
      } finally {
        reconcile.mockRestore();
        load.mockRestore();
      }
    }),
  );
});
