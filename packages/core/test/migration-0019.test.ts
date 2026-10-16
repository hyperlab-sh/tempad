import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTime } from "ulid";
import { syncOneSessionFile } from "../src/collect/claude.ts";
import type { Config } from "../src/config/env.ts";
import { legacyEventUid, openDatabase } from "../src/db/database.ts";
import { MIRROR_SYNC_COLUMNS, SYNCED_UPSERT_TABLES } from "../src/sync/tables.ts";

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OLD_STAMP = "2020-01-01T00:00:00.000Z";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "tempad-migration-0019-"));
}

function userVersion(database: Database): number {
  return (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

interface SyncColumns {
  sync_host: string | null;
  sync_updated_at: string | null;
  sync_dirty: number;
}

function syncColumns(database: Database, table: string, where: string): SyncColumns {
  return database
    .query(`SELECT sync_host, sync_updated_at, sync_dirty FROM ${table} WHERE ${where}`)
    .get() as SyncColumns;
}

/** One row in each of the six mirrors, parents first, as the collectors write them. */
function seedMirrors(database: Database): void {
  database.exec(`
    INSERT INTO gh_repos (full_name, org, is_personal, default_branch, project, meta)
      VALUES ('acme/widgets', 'acme', 0, 'main', 'widgets', NULL);
    INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
      VALUES ('abc123', 'acme/widgets', '["main"]', 'S', 's@x', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'fix it', NULL, 1, 2, 3);
    INSERT INTO gh_pull_requests (repo, number, title, state, author, role, created_at, merged_at, closed_at)
      VALUES ('acme/widgets', 44, 'Fix it', 'open', 's', 'author', '2026-01-01T00:00:00Z', NULL, NULL);
    INSERT INTO monday_items (id, board_id, board_name, group_name, name, status, assignees, timeline_start, timeline_end, time_tracked_seconds, created_at, updated_at, raw, org, project, meta)
      VALUES (7, 1, 'Board', NULL, 'item', NULL, '[]', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{}', 'acme', 'widgets', NULL);
    INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
      VALUES ('s1', '~/.claude', 'dir', '/tmp/s1.jsonl', NULL, 'acme', 'widgets', NULL, 'a title', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 0, '[]', 'host-a', '2026-01-01T00:00:00Z');
    INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, origin_kind, model, text_preview, tool_name, tokens_in, tokens_out)
      VALUES ('m1', 's1', '2026-01-01T00:00:00Z', 'user', 0, 'human', NULL, 'hi', NULL, NULL, NULL);
  `);
}

const MIRROR_KEYS: Record<string, string> = {
  gh_repos: "full_name = 'acme/widgets'",
  gh_commits: "sha = 'abc123'",
  gh_pull_requests: "repo = 'acme/widgets' AND number = 44",
  monday_items: "id = 7",
  claude_sessions: "id = 's1'",
  claude_messages: "uuid = 'm1'",
};

function insertRawEvent(
  database: Database,
  event: { at: string; recordedAt: string; subject: string; payload?: Record<string, unknown> },
): number {
  const row = database
    .query(
      `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload)
       VALUES (?, ?, 'hero', NULL, 'hero.created', ?, ?) RETURNING id`,
    )
    .get(
      event.at,
      event.recordedAt,
      event.subject,
      JSON.stringify(event.payload ?? { name: "x" }),
    ) as { id: number };
  return row.id;
}

function eventUids(database: Database): { id: number; uid: string }[] {
  return database.query("SELECT id, uid FROM events ORDER BY id").all() as {
    id: number;
    uid: string;
  }[];
}

describe("migration 0019_push_sync on a pre-0019 database with data", () => {
  test("adds the sync columns, stamps existing rows dirty, backfills event uids", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    try {
      const old = openDatabase(path, { upToVersion: 18 });
      expect(userVersion(old)).toBe(18);
      seedMirrors(old);
      insertRawEvent(old, {
        at: "2026-09-01T09:00:00.000Z",
        recordedAt: "2026-09-01T09:00:00.000Z",
        subject: "H1",
      });
      insertRawEvent(old, {
        at: "2026-09-01T09:00:01.000Z",
        recordedAt: "2026-09-01T09:00:01.000Z",
        subject: "H2",
      });
      old.close();

      const before = Date.now();
      const database = openDatabase(path, { hostSlug: "host-a" });
      expect(userVersion(database)).toBe(20);
      expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);

      for (const table of SYNCED_UPSERT_TABLES) {
        const columns = syncColumns(database, table.name, MIRROR_KEYS[table.name] as string);
        // Existing rows: stamped at migration time, no host yet, dirty.
        expect(columns.sync_host).toBeNull();
        expect(columns.sync_dirty).toBe(1);
        expect(columns.sync_updated_at).toMatch(STAMP);
        expect(Date.parse(columns.sync_updated_at as string)).toBeGreaterThanOrEqual(before - 1);
      }

      const events = database
        .query("SELECT id, uid, recorded_at, sync_host, sync_dirty FROM events ORDER BY id")
        .all() as {
        id: number;
        uid: string;
        recorded_at: string;
        sync_host: string | null;
        sync_dirty: number;
      }[];
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event.uid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(decodeTime(event.uid)).toBe(Date.parse(event.recorded_at));
        expect(event.sync_host).toBeNull();
        expect(event.sync_dirty).toBe(1);
      }
      expect((events[0] as { uid: string }).uid < (events[1] as { uid: string }).uid).toBe(true);

      expect(database.query("SELECT id, host_slug FROM sync_local").all()).toEqual([
        { id: 1, host_slug: "host-a" },
      ]);
      expect(database.query("SELECT * FROM sync_cursors").all()).toEqual([]);
      expect(database.query("SELECT * FROM sync_tombstones").all()).toEqual([]);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a fresh database migrates straight to head (20)", () => {
    const database = openDatabase(":memory:");
    expect(userVersion(database)).toBe(20);
    expect(database.query("SELECT COUNT(*) AS n FROM sync_local").get()).toEqual({ n: 0 });
    database.close();
  });

  test("openDatabase with a host slug upserts sync_local, replacing a changed slug", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    try {
      openDatabase(path, { hostSlug: "host-a" }).close();
      openDatabase(path).close();
      const reopened = openDatabase(path, { hostSlug: "host-b" });
      expect(reopened.query("SELECT id, host_slug FROM sync_local").all()).toEqual([
        { id: 1, host_slug: "host-b" },
      ]);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("event uid backfill", () => {
  test("walks id order: same-millisecond and backwards recorded_at still give increasing uids", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    try {
      const old = openDatabase(path, { upToVersion: 18 });
      const recordedAts = [
        "2026-09-01T10:00:00.000Z",
        "2026-09-01T10:00:00.000Z", // same millisecond as the previous row
        "2026-09-01T10:00:00.000Z",
        "2026-09-01T09:59:00.000Z", // clock went backwards relative to id
        "2026-09-01T10:00:00.500Z",
        "2026-09-01T08:00:00.000Z", // further backwards
        "2026-09-01T11:00:00.000Z",
      ];
      recordedAts.forEach((recordedAt, index) => {
        insertRawEvent(old, { at: recordedAt, recordedAt, subject: `H${index}` });
      });
      old.close();

      const database = openDatabase(path);
      const rows = eventUids(database);
      expect(rows).toHaveLength(recordedAts.length);
      const sortedByUid = [...rows].sort((a, b) => (a.uid < b.uid ? -1 : 1));
      expect(sortedByUid.map((row) => row.id)).toEqual(rows.map((row) => row.id));
      expect(new Set(rows.map((row) => row.uid)).size).toBe(rows.length);
      // The first row's uid carries its own recorded_at; a backwards seed reuses
      // the previous time instead of going below it.
      expect(decodeTime((rows[0] as { uid: string }).uid)).toBe(
        Date.parse("2026-09-01T10:00:00.000Z"),
      );
      expect(decodeTime((rows[3] as { uid: string }).uid)).toBe(
        Date.parse("2026-09-01T10:00:00.000Z"),
      );
      expect(decodeTime((rows[6] as { uid: string }).uid)).toBe(
        Date.parse("2026-09-01T11:00:00.000Z"),
      );
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("is a no-op on the next open, and a row inserted by hand later sorts after every uid", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    try {
      const old = openDatabase(path, { upToVersion: 18 });
      insertRawEvent(old, {
        at: "2026-09-01T10:00:00.000Z",
        recordedAt: "2026-09-01T10:00:00.000Z",
        subject: "H1",
      });
      old.close();

      const first = openDatabase(path);
      const assigned = eventUids(first);
      // Recorded "earlier" than the existing row, inserted by hand with no uid.
      insertRawEvent(first, {
        at: "2026-08-01T00:00:00.000Z",
        recordedAt: "2026-08-01T00:00:00.000Z",
        subject: "H2",
      });
      first.close();

      const second = openDatabase(path);
      const rows = eventUids(second);
      expect(rows[0]).toEqual(assigned[0] as { id: number; uid: string });
      expect((rows[1] as { uid: string }).uid > (rows[0] as { uid: string }).uid).toBe(true);
      second.close();

      const third = openDatabase(path);
      expect(eventUids(third)).toEqual(rows);
      third.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("legacy uids are deterministic", () => {
  const BENT = [
    "2026-09-01T10:00:00.000Z",
    "2026-09-01T10:00:00.000Z", // same millisecond
    "2026-09-01T09:59:00.000Z", // clock regression
    "2026-09-01T10:00:00.000Z",
    "2026-09-01T10:00:00.500Z",
  ];

  /** A pre-0019 database at `path` with the BENT rows plus `extra`, migrated to head. */
  function migratedCopy(path: string, extra: { subject: string; recordedAt: string }[]) {
    const old = openDatabase(path, { upToVersion: 18 });
    BENT.forEach((recordedAt, index) => {
      insertRawEvent(old, { at: recordedAt, recordedAt, subject: `H${index}` });
    });
    for (const row of extra) {
      insertRawEvent(old, { at: row.recordedAt, recordedAt: row.recordedAt, subject: row.subject });
    }
    old.close();
    const database = openDatabase(path);
    const rows = eventUids(database);
    database.close();
    return rows;
  }

  test("two copies of one fixture backfill to identical uids", () => {
    const directory = temporaryDirectory();
    try {
      const first = migratedCopy(join(directory, "a.db"), []);
      const second = migratedCopy(join(directory, "b.db"), []);
      expect(second).toEqual(first);
      expect(new Set(first.map((row) => row.uid)).size).toBe(BENT.length);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("databases sharing ids 1..N agree on those uids and differ at N+1", () => {
    const directory = temporaryDirectory();
    try {
      const recordedAt = "2026-09-01T10:00:00.000Z";
      const first = migratedCopy(join(directory, "a.db"), [{ subject: "only-a", recordedAt }]);
      const second = migratedCopy(join(directory, "b.db"), [{ subject: "only-b", recordedAt }]);
      expect(second.slice(0, BENT.length)).toEqual(first.slice(0, BENT.length));
      const lastFirst = first[BENT.length] as { id: number; uid: string };
      const lastSecond = second[BENT.length] as { id: number; uid: string };
      expect(lastFirst.id).toBe(lastSecond.id);
      expect(lastFirst.uid).not.toBe(lastSecond.uid);
      // Same id and clamped time: only the content hash (low 40 bits) differs.
      expect(lastFirst.uid.slice(0, 18)).toBe(lastSecond.uid.slice(0, 18));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uid order is id order through clock regression and same-millisecond rows", () => {
    const directory = temporaryDirectory();
    try {
      const rows = migratedCopy(join(directory, "a.db"), [
        { subject: "late-but-earlier", recordedAt: "2026-08-01T00:00:00.000Z" },
      ]);
      const sorted = [...rows].sort((a, b) => (a.uid < b.uid ? -1 : 1));
      expect(sorted.map((row) => row.id)).toEqual(rows.map((row) => row.id));
      // The clamp: a backwards recorded_at reuses the previous time.
      expect(decodeTime((rows[2] as { uid: string }).uid)).toBe(Date.parse(BENT[0] as string));
      expect(decodeTime((rows.at(-1) as { uid: string }).uid)).toBe(
        Date.parse("2026-09-01T10:00:00.500Z"),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the uid layout: time, then the id big-endian in 40 bits, then 40 hash bits", () => {
    const row = {
      id: 3,
      recorded_at: "2026-09-01T10:00:00.000Z",
      kind: "hero.created",
      subject: "H",
      payload: "{}",
    };
    const uid = legacyEventUid(row, Date.parse(row.recorded_at));
    expect(decodeTime(uid)).toBe(Date.parse(row.recorded_at));
    // 40 bits of id = 8 base32 characters right after the 10 time characters.
    expect(uid.slice(10, 18)).toBe("00000003");
    expect(legacyEventUid({ ...row, payload: '{"x":1}' }, Date.parse(row.recorded_at))).not.toBe(
      uid,
    );
  });

  test("an id past the 40-bit ceiling is an explicit error", () => {
    const row = {
      id: 2 ** 40,
      recorded_at: "2026-09-01T10:00:00.000Z",
      kind: "k",
      subject: "s",
      payload: "{}",
    };
    expect(() => legacyEventUid(row, 0)).toThrow("40-bit id ceiling");
    expect(() => legacyEventUid({ ...row, id: 2 ** 40 - 1 }, 0)).not.toThrow();
  });
});

describe("mirror sync triggers", () => {
  test("an insert without a stamp is stamped, tagged with the local host and dirty", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    for (const table of SYNCED_UPSERT_TABLES) {
      const columns = syncColumns(database, table.name, MIRROR_KEYS[table.name] as string);
      expect(columns.sync_updated_at).toMatch(STAMP);
      expect(columns.sync_host).toBe("host-a");
      expect(columns.sync_dirty).toBe(1);
    }
  });

  test("with no sync_local row the insert trigger writes sync_host NULL", () => {
    const database = openDatabase(":memory:");
    seedMirrors(database);
    const columns = syncColumns(database, "gh_commits", "sha = 'abc123'");
    expect(columns.sync_updated_at).toMatch(STAMP);
    expect(columns.sync_host).toBeNull();
    expect(columns.sync_dirty).toBe(1);
  });

  test("an insert carrying its own stamp (a pull) is left exactly as written", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    database.exec(`
      INSERT INTO gh_repos (full_name, org, is_personal, sync_host, sync_updated_at, sync_dirty)
        VALUES ('acme/widgets', 'acme', 0, 'host-b', '${OLD_STAMP}', 0);
    `);
    expect(syncColumns(database, "gh_repos", "full_name = 'acme/widgets'")).toEqual({
      sync_host: "host-b",
      sync_updated_at: OLD_STAMP,
      sync_dirty: 0,
    });
  });

  test("a content update restamps, retags with the local host and re-dirties", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    for (const table of SYNCED_UPSERT_TABLES) {
      const where = MIRROR_KEYS[table.name] as string;
      // As a pull from another host would leave it.
      database.exec(
        `UPDATE ${table.name} SET sync_updated_at = '${OLD_STAMP}', sync_host = 'host-b', sync_dirty = 0 WHERE ${where}`,
      );
      expect(syncColumns(database, table.name, where)).toEqual({
        sync_host: "host-b",
        sync_updated_at: OLD_STAMP,
        sync_dirty: 0,
      });
    }

    database.exec("UPDATE gh_repos SET default_branch = 'trunk'");
    database.exec("UPDATE gh_commits SET subject = 'fix it properly'");
    database.exec("UPDATE gh_pull_requests SET state = 'merged'");
    database.exec("UPDATE monday_items SET status = 'Done'");
    database.exec("UPDATE claude_sessions SET title = 'renamed'");
    database.exec("UPDATE claude_messages SET text_preview = 'edited'");

    for (const table of SYNCED_UPSERT_TABLES) {
      const columns = syncColumns(database, table.name, MIRROR_KEYS[table.name] as string);
      expect(columns.sync_updated_at).toMatch(STAMP);
      expect(columns.sync_updated_at).not.toBe(OLD_STAMP);
      expect(columns.sync_host).toBe("host-a");
      expect(columns.sync_dirty).toBe(1);
    }
  });

  test("a content update with no sync_local row sets sync_host NULL", () => {
    const database = openDatabase(":memory:");
    seedMirrors(database);
    database.exec(
      `UPDATE gh_commits SET sync_updated_at = '${OLD_STAMP}', sync_host = 'host-b', sync_dirty = 0`,
    );
    database.exec("UPDATE gh_commits SET subject = 'changed'");
    const columns = syncColumns(database, "gh_commits", "sha = 'abc123'");
    expect(columns.sync_updated_at).not.toBe(OLD_STAMP);
    expect(columns.sync_host).toBeNull();
    expect(columns.sync_dirty).toBe(1);
  });

  test("marking a row pushed (sync_dirty, filling sync_host) does not restamp", () => {
    const database = openDatabase(":memory:");
    seedMirrors(database);
    database.exec(`UPDATE gh_commits SET sync_updated_at = '${OLD_STAMP}'`);
    expect(syncColumns(database, "gh_commits", "sha = 'abc123'")).toEqual({
      sync_host: null,
      sync_updated_at: OLD_STAMP,
      sync_dirty: 1,
    });

    database.exec("UPDATE gh_commits SET sync_host = 'host-a', sync_dirty = 0");
    expect(syncColumns(database, "gh_commits", "sha = 'abc123'")).toEqual({
      sync_host: "host-a",
      sync_updated_at: OLD_STAMP,
      sync_dirty: 0,
    });

    database.exec("UPDATE gh_commits SET sync_host = 'host-c'");
    expect(syncColumns(database, "gh_commits", "sha = 'abc123'").sync_updated_at).toBe(OLD_STAMP);
  });

  test("an update writing an explicit new stamp (a pull) is not restamped", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    database.exec(
      `UPDATE gh_pull_requests SET title = 'pulled title', sync_updated_at = '${OLD_STAMP}', sync_host = 'host-b', sync_dirty = 0`,
    );
    expect(
      database
        .query("SELECT title, sync_host, sync_updated_at, sync_dirty FROM gh_pull_requests")
        .get(),
    ).toEqual({
      title: "pulled title",
      sync_host: "host-b",
      sync_updated_at: OLD_STAMP,
      sync_dirty: 0,
    });
  });

  test("an update that writes identical content values (an unguarded upsert) does not fire", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    database.exec(
      `UPDATE gh_repos SET sync_updated_at = '${OLD_STAMP}', sync_host = 'host-b', sync_dirty = 0`,
    );
    // gh_repos' collector upsert has no IS NOT guard: it always runs its SET.
    database.exec(`
      INSERT INTO gh_repos (full_name, org, is_personal, default_branch, project, meta)
      VALUES ('acme/widgets', 'acme', 0, 'main', 'widgets', NULL)
      ON CONFLICT(full_name) DO UPDATE SET
        default_branch = COALESCE(excluded.default_branch, gh_repos.default_branch),
        org = excluded.org,
        project = excluded.project,
        meta = excluded.meta
    `);
    expect(syncColumns(database, "gh_repos", "full_name = 'acme/widgets'")).toEqual({
      sync_host: "host-b",
      sync_updated_at: OLD_STAMP,
      sync_dirty: 0,
    });
  });

  test("the github commit upsert re-run with identical values leaves the row clean", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    // A faithful copy of upsertCommit's SQL (src/collect/github.ts).
    const upsert = database.query(
      `INSERT INTO gh_commits
         (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body, files_changed, insertions, deletions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sha) DO UPDATE SET
         branches = excluded.branches,
         author_name = excluded.author_name,
         author_email = excluded.author_email,
         authored_at = excluded.authored_at,
         committed_at = excluded.committed_at,
         subject = excluded.subject,
         body = excluded.body,
         files_changed = excluded.files_changed,
         insertions = excluded.insertions,
         deletions = excluded.deletions
       WHERE gh_commits.repo IS NOT excluded.repo
         OR gh_commits.branches IS NOT excluded.branches
         OR gh_commits.author_name IS NOT excluded.author_name
         OR gh_commits.author_email IS NOT excluded.author_email
         OR gh_commits.authored_at IS NOT excluded.authored_at
         OR gh_commits.committed_at IS NOT excluded.committed_at
         OR gh_commits.subject IS NOT excluded.subject
         OR gh_commits.body IS NOT excluded.body
         OR gh_commits.files_changed IS NOT excluded.files_changed
         OR gh_commits.insertions IS NOT excluded.insertions
         OR gh_commits.deletions IS NOT excluded.deletions`,
    );
    const values = [
      "abc123",
      "acme/widgets",
      '["main"]',
      "S",
      "s@x",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      "fix it",
      null,
      1,
      2,
      3,
    ] as const;
    database.exec(
      `UPDATE gh_commits SET sync_updated_at = '${OLD_STAMP}', sync_host = 'host-a', sync_dirty = 0`,
    );
    upsert.run(...values);
    expect(syncColumns(database, "gh_commits", "sha = 'abc123'")).toEqual({
      sync_host: "host-a",
      sync_updated_at: OLD_STAMP,
      sync_dirty: 0,
    });

    upsert.run(...values.map((value, index) => (index === 7 ? "a new subject" : value)));
    const changed = syncColumns(database, "gh_commits", "sha = 'abc123'");
    expect(changed.sync_updated_at).not.toBe(OLD_STAMP);
    expect(changed.sync_dirty).toBe(1);
  });

  test("the real claude collector re-syncing an unchanged session file leaves rows clean", async () => {
    const root = temporaryDirectory();
    try {
      const home = join(root, "home");
      const claudeDirectory = join(root, "claude");
      const sessionDirectory = join(claudeDirectory, "projects", "plain-project");
      mkdirSync(home, { recursive: true });
      mkdirSync(sessionDirectory, { recursive: true });
      const sessionFile = join(sessionDirectory, "session-1.jsonl");
      const lines = [
        {
          type: "user",
          uuid: "u1",
          sessionId: "sess-1",
          timestamp: "2026-01-01T10:00:00.000Z",
          cwd: "/nowhere",
          origin: { kind: "human" },
          message: { role: "user", content: "hello there" },
        },
        {
          type: "assistant",
          uuid: "a1",
          sessionId: "sess-1",
          timestamp: "2026-01-01T10:00:05.000Z",
          cwd: "/nowhere",
          message: {
            role: "assistant",
            model: "claude-x",
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ];
      writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      const config: Config = {
        mondayApiToken: "x",
        mondayUser: "x",
        ghUser: "x",
        ghOrgs: [],
        ghIncludePersonal: false,
        ghToken: undefined,
        gitAuthorEmails: [],
        claudeDirs: [claudeDirectory],
        hostSlug: "host-a",
        tz: "UTC",
        since: "2020-01-01T00:00:00Z",
        home,
      };

      const database = openDatabase(join(root, "tempad.db"), { hostSlug: "host-a" });
      await syncOneSessionFile(database, config, sessionFile);
      expect(database.query("SELECT COUNT(*) AS n FROM claude_messages").get()).toEqual({ n: 2 });
      // As push would leave them.
      database.exec(
        `UPDATE claude_sessions SET sync_updated_at = '${OLD_STAMP}', sync_dirty = 0;
         UPDATE claude_messages SET sync_updated_at = '${OLD_STAMP}', sync_dirty = 0;`,
      );

      // Re-reads the file: messages go through INSERT OR IGNORE again, and the
      // session takes the collector's own "unchanged" path. (Its upsert has no
      // IS NOT guard; an identical unguarded upsert is covered on gh_repos.)
      await syncOneSessionFile(database, config, sessionFile);

      expect(syncColumns(database, "claude_sessions", "id = 'sess-1'")).toEqual({
        sync_host: "host-a",
        sync_updated_at: OLD_STAMP,
        sync_dirty: 0,
      });
      const messages = database
        .query("SELECT sync_host, sync_updated_at, sync_dirty FROM claude_messages")
        .all();
      expect(messages).toEqual([
        { sync_host: "host-a", sync_updated_at: OLD_STAMP, sync_dirty: 0 },
        { sync_host: "host-a", sync_updated_at: OLD_STAMP, sync_dirty: 0 },
      ]);
      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a delete writes a tombstone keyed by the JSON natural key, composite PR key included", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    database.exec(`
      DELETE FROM claude_messages;
      DELETE FROM claude_sessions;
      DELETE FROM gh_pull_requests;
      DELETE FROM gh_commits;
      DELETE FROM monday_items;
      DELETE FROM gh_repos;
    `);
    const tombstones = database
      .query("SELECT tbl, pk, deleted_at, sync_host, sync_dirty FROM sync_tombstones ORDER BY tbl")
      .all() as {
      tbl: string;
      pk: string;
      deleted_at: string;
      sync_host: string;
      sync_dirty: number;
    }[];
    expect(
      tombstones.map(({ tbl, pk, sync_host, sync_dirty }) => ({ tbl, pk, sync_host, sync_dirty })),
    ).toEqual([
      { tbl: "claude_messages", pk: '["m1"]', sync_host: "host-a", sync_dirty: 1 },
      { tbl: "claude_sessions", pk: '["s1"]', sync_host: "host-a", sync_dirty: 1 },
      { tbl: "gh_commits", pk: '["abc123"]', sync_host: "host-a", sync_dirty: 1 },
      { tbl: "gh_pull_requests", pk: '["acme/widgets",44]', sync_host: "host-a", sync_dirty: 1 },
      { tbl: "gh_repos", pk: '["acme/widgets"]', sync_host: "host-a", sync_dirty: 1 },
      { tbl: "monday_items", pk: "[7]", sync_host: "host-a", sync_dirty: 1 },
    ]);
    for (const tombstone of tombstones) expect(tombstone.deleted_at).toMatch(STAMP);
    // The pk matches what the TS side will build for the same key.
    expect(JSON.stringify(["acme/widgets", 44])).toBe('["acme/widgets",44]');
  });

  test("a re-delete after a re-insert refreshes the tombstone instead of failing", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    database.exec("DELETE FROM gh_pull_requests");
    // As push would leave it.
    database.exec(
      `UPDATE sync_tombstones SET deleted_at = '${OLD_STAMP}', sync_host = 'host-b', sync_dirty = 0`,
    );
    database.exec(`
      INSERT INTO gh_pull_requests (repo, number, title, state, author, role, created_at)
        VALUES ('acme/widgets', 44, 'Fix it', 'open', 's', 'author', '2026-01-01T00:00:00Z');
      DELETE FROM gh_pull_requests;
    `);
    const tombstones = database.query("SELECT * FROM sync_tombstones").all() as {
      deleted_at: string;
      sync_host: string;
      sync_dirty: number;
    }[];
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.deleted_at).not.toBe(OLD_STAMP);
    expect(tombstones[0]?.sync_host).toBe("host-a");
    expect(tombstones[0]?.sync_dirty).toBe(1);
  });

  test("each mirror's update trigger names every content column and no local one (fails when a column is added)", () => {
    const database = openDatabase(":memory:");
    for (const table of SYNCED_UPSERT_TABLES) {
      const triggers = database
        .query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
        .all(table.name) as { name: string; sql: string }[];
      expect(triggers.map((trigger) => trigger.name).sort()).toEqual([
        `${table.name}_sync_delete`,
        `${table.name}_sync_insert`,
        `${table.name}_sync_update`,
      ]);
      const update = triggers.find((trigger) => trigger.name === `${table.name}_sync_update`);
      const columns = (
        database.query(`SELECT name FROM pragma_table_info('${table.name}')`).all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      for (const column of MIRROR_SYNC_COLUMNS) expect(columns).toContain(column);
      // Every column is exactly one of: sync-owned, host-local, or content.
      for (const column of table.localColumns) {
        expect(columns).toContain(column);
        expect(MIRROR_SYNC_COLUMNS).not.toContain(column);
        expect(table.keyColumns).not.toContain(column);
        expect(update?.sql).not.toContain(`NEW.${column} IS NOT OLD.${column}`);
      }
      const content = columns.filter(
        (name) => !MIRROR_SYNC_COLUMNS.includes(name) && !table.localColumns.includes(name),
      );
      for (const column of content) {
        expect(update?.sql).toContain(`NEW.${column} IS NOT OLD.${column}`);
      }
      // No trigger compares a column the table lacks.
      const compared = [...(update?.sql ?? "").matchAll(/NEW\.(\w+) IS NOT OLD\./g)].map(
        (match) => match[1],
      );
      expect(compared.sort()).toEqual([...content].sort());
      const remove = triggers.find((trigger) => trigger.name === `${table.name}_sync_delete`);
      expect(remove?.sql).toContain(
        `json_array(${table.keyColumns.map((key) => `OLD.${key}`).join(", ")})`,
      );
    }
  });
});

const FUTURE_STAMP = "2999-01-01T00:00:00.000Z";

describe("per-key stamps are strictly increasing on one host", () => {
  test("a host-local column (gh_repos.mirrored_at) is not content: no restamp, no re-dirty", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    database.exec(
      `UPDATE gh_repos SET sync_updated_at = '${OLD_STAMP}', sync_host = 'host-b', sync_dirty = 0`,
    );
    database.exec("UPDATE gh_repos SET mirrored_at = '2026-10-01T00:00:00Z'");
    expect(syncColumns(database, "gh_repos", MIRROR_KEYS.gh_repos as string)).toEqual({
      sync_host: "host-b",
      sync_updated_at: OLD_STAMP,
      sync_dirty: 0,
    });
  });

  test("1000 content updates in the same millisecond each step exactly +1 ms (no rounding drift)", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    // A stamp far ahead of the wall clock: every update lands in "the same
    // millisecond" as far as MAX(now, previous + 1 ms) is concerned.
    database.exec(`UPDATE gh_commits SET sync_updated_at = '${FUTURE_STAMP}'`);
    const update = database.query("UPDATE gh_commits SET insertions = ? WHERE sha = 'abc123'");
    const read = database.query("SELECT sync_updated_at FROM gh_commits WHERE sha = 'abc123'");
    let previous = FUTURE_STAMP;
    for (let index = 1; index <= 1000; index += 1) {
      update.run(1000 + index);
      const stamp = (read.get() as { sync_updated_at: string }).sync_updated_at;
      expect(stamp).toMatch(STAMP);
      expect(Date.parse(stamp) - Date.parse(previous)).toBe(1);
      previous = stamp;
    }
    expect(previous).toBe("2999-01-01T00:00:01.000Z");
  });

  test("1000 back-to-back content updates at the real clock never repeat a stamp", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    const update = database.query("UPDATE claude_messages SET tokens_in = ? WHERE uuid = 'm1'");
    const read = database.query("SELECT sync_updated_at FROM claude_messages WHERE uuid = 'm1'");
    let previous = (read.get() as { sync_updated_at: string }).sync_updated_at;
    for (let index = 1; index <= 1000; index += 1) {
      update.run(index);
      const stamp = (read.get() as { sync_updated_at: string }).sync_updated_at;
      expect(stamp > previous).toBe(true);
      previous = stamp;
    }
  });

  test("a delete's tombstone is stamped after the deleted version", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    database.exec(`UPDATE gh_pull_requests SET sync_updated_at = '${FUTURE_STAMP}'`);
    database.exec("DELETE FROM gh_pull_requests");
    expect(
      database
        .query("SELECT pk, deleted_at FROM sync_tombstones WHERE tbl = 'gh_pull_requests'")
        .get(),
    ).toEqual({ pk: '["acme/widgets",44]', deleted_at: "2999-01-01T00:00:00.001Z" });
  });

  test("a re-insert is stamped after the key's tombstone, which stays and loses by stamp", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    seedMirrors(database);
    database.exec(`UPDATE claude_messages SET sync_updated_at = '${FUTURE_STAMP}'`);
    database.exec("DELETE FROM claude_messages");
    database.exec(
      "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, origin_kind) VALUES ('m1', 's1', '2026-01-01T00:00:00Z', 'user', 0, 'human')",
    );
    expect(syncColumns(database, "claude_messages", MIRROR_KEYS.claude_messages as string)).toEqual(
      { sync_host: "host-a", sync_updated_at: "2999-01-01T00:00:00.002Z", sync_dirty: 1 },
    );
    expect(
      database.query("SELECT deleted_at FROM sync_tombstones WHERE tbl = 'claude_messages'").get(),
    ).toEqual({ deleted_at: "2999-01-01T00:00:00.001Z" });
    // A different key's tombstone does not bump an unrelated insert.
    database.exec(
      "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, origin_kind) VALUES ('m2', 's1', '2026-01-01T00:00:00Z', 'user', 0, 'human')",
    );
    const other = syncColumns(database, "claude_messages", "uuid = 'm2'").sync_updated_at as string;
    expect(other < FUTURE_STAMP).toBe(true);
  });
});

describe("events_no_update after 0019", () => {
  function eventDatabase(): { database: Database; id: number } {
    const database = openDatabase(":memory:");
    const id = insertRawEvent(database, {
      at: "2026-09-01T10:00:00.000Z",
      recordedAt: "2026-09-01T10:00:00.000Z",
      subject: "H1",
    });
    return { database, id };
  }

  test("filling a NULL uid and a NULL sync_host is allowed", () => {
    const { database, id } = eventDatabase();
    database.query("UPDATE events SET uid = '01J00000000000000000000000' WHERE id = ?").run(id);
    database.query("UPDATE events SET sync_host = 'host-a' WHERE id = ?").run(id);
    expect(database.query("SELECT uid, sync_host FROM events").get()).toEqual({
      uid: "01J00000000000000000000000",
      sync_host: "host-a",
    });
  });

  test("clearing sync_dirty from 1 to 0 is allowed, setting it back is not", () => {
    const { database, id } = eventDatabase();
    database.query("UPDATE events SET sync_dirty = 0 WHERE id = ?").run(id);
    expect(database.query("SELECT sync_dirty FROM events").get()).toEqual({ sync_dirty: 0 });
    expect(() => database.query("UPDATE events SET sync_dirty = 1 WHERE id = ?").run(id)).toThrow(
      "events are append-only",
    );
  });

  test("changing a set uid or sync_host is rejected", () => {
    const { database, id } = eventDatabase();
    database
      .query(
        "UPDATE events SET uid = '01J00000000000000000000000', sync_host = 'host-a' WHERE id = ?",
      )
      .run(id);
    expect(() =>
      database.query("UPDATE events SET uid = '01J00000000000000000000001' WHERE id = ?").run(id),
    ).toThrow("events are append-only");
    expect(() => database.query("UPDATE events SET uid = NULL WHERE id = ?").run(id)).toThrow(
      "events are append-only",
    );
    expect(() =>
      database.query("UPDATE events SET sync_host = 'host-b' WHERE id = ?").run(id),
    ).toThrow("events are append-only");
  });

  test("changing content is rejected, even alongside an allowed fill", () => {
    const { database, id } = eventDatabase();
    expect(() =>
      database.query(`UPDATE events SET payload = '{"name":"y"}' WHERE id = ?`).run(id),
    ).toThrow("events are append-only");
    expect(() =>
      database
        .query(
          `UPDATE events SET uid = '01J00000000000000000000000', kind = 'saga.created' WHERE id = ?`,
        )
        .run(id),
    ).toThrow("events are append-only");
    expect(() => database.query("UPDATE events SET id = 99 WHERE id = ?").run(id)).toThrow(
      "events are append-only",
    );
    expect(database.query("SELECT uid, payload FROM events").get()).toEqual({
      uid: null,
      payload: '{"name":"x"}',
    });
  });

  test("delete is still rejected", () => {
    const { database, id } = eventDatabase();
    expect(() => database.query("DELETE FROM events WHERE id = ?").run(id)).toThrow(
      "events are append-only",
    );
  });

  test("the trigger names every events column (fails when a column is added)", () => {
    const database = openDatabase(":memory:");
    const trigger = database
      .query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'events_no_update'")
      .get() as { sql: string };
    const columns = (
      database.query("SELECT name FROM pragma_table_info('events')").all() as { name: string }[]
    ).map((column) => column.name);
    for (const column of columns) expect(trigger.sql).toContain(`NEW.${column} IS OLD.${column}`);
  });
});
