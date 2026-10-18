import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeOffsetTimestamp, toUtcIso } from "../src/collect/github/log.ts";
import { openDatabase } from "../src/db/database.ts";
import { runSyncEngine } from "../src/sync/engine.ts";
import { enableMirrorSync } from "../src/sync/triggers.ts";
import { FakeRemote, temporaryDirectory } from "./sync/helpers.ts";

/**
 * Migration 0021 converts commit dates with SQLite's strftime, which returns NULL
 * for an offset of +-15:00 or more, so it kept those in offset form while
 * toUtcIso and the pull path (new Date(...).toISOString()) store UTC. The step
 * after the migrations in openDatabase closes that gap.
 */

interface Row {
  sha: string;
  authored_at: string;
  committed_at: string;
  sync_host: string | null;
  sync_updated_at: string | null;
  sync_dirty: number;
}

const STAMP = "2026-09-10T12:00:00.000Z";
const PENDING = "2026-09-11T08:30:00.123Z";

interface Seed {
  sha: string;
  authoredAt: string;
  committedAt: string;
  syncHost: string | null;
  syncUpdatedAt: string | null;
  syncDirty: number;
}

const SEEDS: Seed[] = [
  // Wide offsets: SQLite's strftime gives NULL, so 0021 leaves them.
  {
    sha: "w1",
    authoredAt: "2026-09-08T08:30:00+15:30",
    committedAt: "2026-09-08T08:30:00+15:30",
    syncHost: "host-a",
    syncUpdatedAt: STAMP,
    syncDirty: 0,
  },
  {
    sha: "w2",
    authoredAt: "2026-09-08T23:59:00-23:59",
    committedAt: "2026-12-31T23:30:00-18:00",
    syncHost: null,
    syncUpdatedAt: PENDING,
    syncDirty: 1,
  },
  // One wide, one already UTC.
  {
    sha: "w3",
    authoredAt: "2026-09-08T10:00:00+15:00",
    committedAt: "2026-09-08T13:00:00.000Z",
    syncHost: "host-a",
    syncUpdatedAt: STAMP,
    syncDirty: 0,
  },
  // The widest offset SQLite still reads, and plain UTC.
  {
    sha: "n1",
    authoredAt: "2026-09-08T08:00:00+14:00",
    committedAt: "2026-09-07T23:00:00-14:00",
    syncHost: "host-a",
    syncUpdatedAt: STAMP,
    syncDirty: 0,
  },
  {
    sha: "z1",
    authoredAt: "2026-09-08T02:00:00.000Z",
    committedAt: "2026-01-01T00:00:00Z",
    syncHost: null,
    syncUpdatedAt: PENDING,
    syncDirty: 1,
  },
  // Offset-shaped but unreadable by both SQLite and JavaScript: left as it is.
  {
    sha: "bad",
    authoredAt: "9999-99-99T99:99:99+16:00",
    committedAt: "2026-09-08T02:00:00.000Z",
    syncHost: null,
    syncUpdatedAt: PENDING,
    syncDirty: 1,
  },
  // Lowercase 't': SQLite's strftime reads only 'T', JavaScript reads both, so 0021 leaves it.
  {
    sha: "lower-t",
    authoredAt: "2026-09-07t23:00:00-03:00",
    committedAt: "2026-09-07t23:05:00-03:00",
    syncHost: "host-a",
    syncUpdatedAt: STAMP,
    syncDirty: 0,
  },
  // A null stamp (never stamped) stays null.
  {
    sha: "null-stamp",
    authoredAt: "2026-09-08T08:30:00+16:00",
    committedAt: "2026-09-08T08:30:00+16:00",
    syncHost: null,
    syncUpdatedAt: null,
    syncDirty: 1,
  },
];

const WIDE = ["w1", "w2", "w3", "null-stamp"];
const SCHEMA_BEFORE_STEP = 22;
// A full open migrates to the head schema, past the step at 23.
const SCHEMA_HEAD = 26;

function seed(database: Database): void {
  database.exec(`
    INSERT INTO gh_repos (full_name, org, is_personal, default_branch, project, meta)
      VALUES ('acme/widgets', 'acme', 0, 'main', 'widgets', NULL);
  `);
  const insert = database.query(
    `INSERT INTO gh_commits
       (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body,
        files_changed, insertions, deletions, sync_host, sync_updated_at, sync_dirty)
     VALUES (?, 'acme/widgets', '["main"]', 'S', 's@x', ?, ?, 'subject', 'body', 1, 2, 3, ?, ?, ?)`,
  );
  for (const row of SEEDS) {
    insert.run(
      row.sha,
      row.authoredAt,
      row.committedAt,
      row.syncHost,
      row.syncUpdatedAt ?? PENDING,
      row.syncDirty,
    );
    if (row.syncUpdatedAt === null) {
      database.query("UPDATE gh_commits SET sync_updated_at = NULL WHERE sha = ?").run(row.sha);
    }
  }
}

function snapshot(database: Database): Row[] {
  return database
    .query(
      `SELECT sha, authored_at, committed_at, sync_host, sync_updated_at, sync_dirty
         FROM gh_commits ORDER BY sha`,
    )
    .all() as Row[];
}

function syncColumns(rows: Row[]) {
  return rows.map(({ sha, sync_host, sync_updated_at, sync_dirty }) => ({
    sha,
    sync_host,
    sync_updated_at,
    sync_dirty,
  }));
}

function expectedText(value: string): string {
  // Offset form that parses becomes what the collector writes; UTC and unreadable text are kept.
  const offsetForm = /[-+]\d{2}:\d{2}$/.test(value);
  return offsetForm && !Number.isNaN(new Date(value).getTime()) ? toUtcIso(value) : value;
}

function dataVersion(database: Database): number {
  return (database.query("PRAGMA data_version").get() as { data_version: number }).data_version;
}

let directory: string;
let path: string;

beforeEach(() => {
  directory = temporaryDirectory("tempad-wide-offsets-");
  path = join(directory, "tempad.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** A database as 0.2.0 left it: migrated through 0022, rows still in offset form. */
function seededBeforeStep(): void {
  const old = openDatabase(path, { upToVersion: SCHEMA_BEFORE_STEP });
  seed(old);
  old.close();
}

function userVersion(database: Database): number {
  return (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

describe("commit dates with offsets of +-15:00 or more", () => {
  test("every row ends in the exact text toUtcIso gives, whatever the offset", () => {
    seededBeforeStep();
    const database = openDatabase(path);
    const rows = new Map(snapshot(database).map((row) => [row.sha, row]));
    for (const original of SEEDS) {
      const row = rows.get(original.sha);
      expect(row?.authored_at).toBe(expectedText(original.authoredAt));
      expect(row?.committed_at).toBe(expectedText(original.committedAt));
    }
    // Spot-check the values, so the helper cannot hide a shared mistake.
    expect(rows.get("w1")?.authored_at).toBe("2026-09-07T17:00:00.000Z");
    expect(rows.get("w2")?.authored_at).toBe("2026-09-09T23:58:00.000Z");
    expect(rows.get("w2")?.committed_at).toBe("2027-01-01T17:30:00.000Z");
    expect(rows.get("w3")?.authored_at).toBe("2026-09-07T19:00:00.000Z");
    expect(rows.get("lower-t")?.authored_at).toBe("2026-09-08T02:00:00.000Z");
    expect(rows.get("lower-t")?.committed_at).toBe("2026-09-08T02:05:00.000Z");
    expect(rows.get("n1")?.authored_at).toBe("2026-09-07T18:00:00.000Z");
    expect(rows.get("n1")?.committed_at).toBe("2026-09-08T13:00:00.000Z");
    // Plain UTC (with or without milliseconds) and an unreadable value are byte-identical.
    expect(rows.get("z1")?.authored_at).toBe("2026-09-08T02:00:00.000Z");
    expect(rows.get("z1")?.committed_at).toBe("2026-01-01T00:00:00Z");
    expect(rows.get("bad")?.authored_at).toBe("9999-99-99T99:99:99+16:00");
    database.close();
  });

  test("the SQL path and the TypeScript path agree for every offset in range", () => {
    // The offsets 0021's strftime can read (<= 14:59) and those it cannot.
    const cases = ["+00:00", "-00:00", "+14:00", "+14:59", "+15:00", "+23:59", "-14:59", "-23:59"];
    const old = openDatabase(path, { upToVersion: 20 });
    old.exec(`
      INSERT INTO gh_repos (full_name, org, is_personal, default_branch, project, meta)
        VALUES ('acme/widgets', 'acme', 0, 'main', 'widgets', NULL);
    `);
    const insert = old.query(
      `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject)
       VALUES (?, 'acme/widgets', '["main"]', 'S', 's@x', ?, ?, 's')`,
    );
    for (const offset of cases) {
      const value = `2026-09-08T12:34:56${offset}`;
      insert.run(`sha${offset}`, value, value);
    }
    old.close();

    const database = openDatabase(path);
    for (const row of snapshot(database)) {
      const offset = row.sha.slice(3);
      const value = `2026-09-08T12:34:56${offset}`;
      expect(row.authored_at).toBe(toUtcIso(value));
      expect(row.committed_at).toBe(normalizeOffsetTimestamp(value));
    }
    database.close();
  });

  for (const syncEnabled of [false, true]) {
    test(`stamp, host and dirty flag are untouched (mirror sync ${syncEnabled ? "on" : "off"})`, () => {
      const old = openDatabase(path, { upToVersion: SCHEMA_BEFORE_STEP });
      if (syncEnabled) enableMirrorSync(old);
      seed(old);
      const before = snapshot(old);
      old.close();

      const database = openDatabase(path);
      const after = snapshot(database);
      expect(after).not.toEqual(before);
      for (const [index, row] of after.entries()) {
        const original = before[index] as Row;
        expect(row.sync_host).toBe(original.sync_host);
        expect(row.sync_updated_at).toBe(original.sync_updated_at);
        expect(row.sync_dirty).toBe(original.sync_dirty);
      }
      expect(database.query("SELECT COUNT(*) AS n FROM sync_tombstones").get()).toEqual({ n: 0 });
      expect(
        database
          .query("SELECT COUNT(*) AS n FROM gh_commits WHERE sync_updated_at LIKE '%~'")
          .get(),
      ).toEqual({ n: 0 });
      expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      database.close();
    });
  }

  test("reopening rewrites nothing, does not write, and never scans again", () => {
    seededBeforeStep();
    const first = openDatabase(path);
    expect(userVersion(first)).toBe(SCHEMA_HEAD);
    const once = snapshot(first);
    const version = dataVersion(first);

    // `PRAGMA data_version` changes when another connection commits a write.
    const second = openDatabase(path);
    expect(snapshot(second)).toEqual(once);
    expect(dataVersion(first)).toBe(version);
    second.close();
    first.close();
  });

  test("the step is tied to the version: a wide row added at version 23 is left alone, a restored v22 backup reruns it", () => {
    seededBeforeStep();
    openDatabase(path).close();

    // Nothing writes this form any more (collector and pull both normalize), so a
    // wide row present now can only show that the second open did not scan.
    const raw = new Database(path);
    raw
      .query(
        `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject)
         VALUES ('late', 'acme/widgets', '["main"]', 'S', 's@x', '2026-09-08T08:30:00+16:00', '2026-09-08T08:30:00+16:00', 's')`,
      )
      .run();
    raw.close();
    const reopened = openDatabase(path);
    expect(
      reopened.query("SELECT authored_at FROM gh_commits WHERE sha = 'late'").get() as Row,
    ).toEqual({ authored_at: "2026-09-08T08:30:00+16:00" } as Row);
    reopened.close();

    // A backup restored from before 0023 has the lower version and does the work again.
    const restored = new Database(path);
    restored.exec(`PRAGMA user_version = ${SCHEMA_BEFORE_STEP}`);
    restored.close();
    const repaired = openDatabase(path);
    expect(userVersion(repaired)).toBe(SCHEMA_HEAD);
    expect(
      repaired.query("SELECT authored_at FROM gh_commits WHERE sha = 'late'").get() as Row,
    ).toEqual({ authored_at: "2026-09-07T16:30:00.000Z" } as Row);
    repaired.close();
  });

  test("a failure inside the step rolls back the rewrite and the version bump", () => {
    seededBeforeStep();
    const before = snapshot(new Database(path, { readonly: true }));

    const raw = new Database(path);
    raw.exec(
      `CREATE TRIGGER boom BEFORE UPDATE ON gh_commits
       BEGIN SELECT RAISE(ABORT, 'step failed'); END`,
    );
    raw.close();
    expect(() => openDatabase(path)).toThrow(/step failed/);

    const check = new Database(path);
    expect(userVersion(check)).toBe(SCHEMA_BEFORE_STEP);
    expect(snapshot(check)).toEqual(before);
    check.exec("DROP TRIGGER boom");
    check.close();

    // The next open does the work, once, and bumps the version with it.
    const database = openDatabase(path);
    expect(userVersion(database)).toBe(SCHEMA_HEAD);
    expect(
      (database.query("SELECT authored_at FROM gh_commits WHERE sha = 'w1'").get() as Row)
        .authored_at,
    ).toBe("2026-09-07T17:00:00.000Z");
    database.close();
  });

  test("a chain from 0020 runs 0021 in SQL and the step after it, atomically with 0022", () => {
    const old = openDatabase(path, { upToVersion: 20 });
    seed(old);
    const before = syncColumns(snapshot(old));
    old.close();

    const database = openDatabase(path);
    expect(userVersion(database)).toBe(SCHEMA_HEAD);
    for (const row of snapshot(database)) {
      const original = SEEDS.find((candidate) => candidate.sha === row.sha) as Seed;
      expect(row.authored_at).toBe(expectedText(original.authoredAt));
      expect(row.committed_at).toBe(expectedText(original.committedAt));
    }
    // 0021 and 0023 rewrite content without restamping, re-tagging or re-dirtying.
    expect(syncColumns(snapshot(database))).toEqual(before);
    database.close();
  });

  test("a later content change still restamps and re-dirties a normalized row", () => {
    const old = openDatabase(path, { upToVersion: SCHEMA_BEFORE_STEP });
    enableMirrorSync(old);
    seed(old);
    old.close();

    const database = openDatabase(path, { hostSlug: "host-b" });
    database.query("UPDATE gh_commits SET subject = 'edited' WHERE sha = 'w1'").run();
    const row = snapshot(database).find((candidate) => candidate.sha === "w1");
    expect(row?.sync_dirty).toBe(1);
    expect(row?.sync_host).toBe("host-b");
    expect((row?.sync_updated_at ?? "") > STAMP).toBe(true);
    database.close();
  });

  test("an empty database and one without gh_commits rows open cleanly", () => {
    const database = openDatabase(":memory:");
    expect(snapshot(database)).toEqual([]);
    database.close();
  });
});

describe("one canonical text per instant across hosts", () => {
  let remote: FakeRemote;

  beforeEach(() => {
    remote = new FakeRemote();
  });

  test("a row rewritten locally and the same row pulled hold identical text", async () => {
    // Host A: the wide-offset rows are rewritten by the open step, then pushed.
    const hostA = openDatabase(join(directory, "a.db"), { upToVersion: SCHEMA_BEFORE_STEP });
    seed(hostA);
    hostA.close();
    const rewritten = openDatabase(join(directory, "a.db"), { hostSlug: "host-a" });
    enableMirrorSync(rewritten);
    await runSyncEngine(rewritten, remote, {
      hostSlug: "host-a",
      batchSize: 500,
      push: true,
      pull: true,
    });

    // The server may still hold the offset text a pre-0021 host pushed.
    for (const sha of WIDE) {
      const original = SEEDS.find((candidate) => candidate.sha === sha) as Seed;
      remote.database
        .query(
          `UPDATE sync_rows
              SET data = json_set(data, '$.authored_at', ?, '$.committed_at', ?)
            WHERE tbl = 'gh_commits' AND pk = json_array(?)`,
        )
        .run(original.authoredAt, original.committedAt, sha);
    }

    const hostB = openDatabase(join(directory, "b.db"), { hostSlug: "host-b" });
    enableMirrorSync(hostB);
    const pulled = await runSyncEngine(hostB, remote, {
      hostSlug: "host-b",
      batchSize: 500,
      push: true,
      pull: true,
    });
    expect(pulled.pulled.rows).toBeGreaterThan(0);

    const text = (database: Database) =>
      database
        .query("SELECT sha, authored_at, committed_at FROM gh_commits WHERE sha IN (?, ?, ?, ?)")
        .all(...WIDE);
    expect(text(hostB)).toEqual(text(rewritten));
    expect(text(rewritten)).toEqual(
      WIDE.map((sha) => {
        const original = SEEDS.find((candidate) => candidate.sha === sha) as Seed;
        return {
          sha,
          authored_at: toUtcIso(original.authoredAt),
          committed_at: toUtcIso(original.committedAt),
        };
      }).sort((left, right) => left.sha.localeCompare(right.sha)),
    );

    // Neither host has anything left to push: no loop.
    for (const [database, slug] of [
      [rewritten, "host-a"],
      [hostB, "host-b"],
    ] as const) {
      const again = await runSyncEngine(database, remote, {
        hostSlug: slug,
        batchSize: 500,
        push: true,
        pull: true,
      });
      expect(again.pushed).toEqual({ events: 0, rows: 0, tombstones: 0 });
    }
    rewritten.close();
    hostB.close();
  });
});
