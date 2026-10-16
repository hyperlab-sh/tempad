import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLogOutput } from "../src/collect/github/log.ts";
import { openDatabase } from "../src/db/database.ts";
import { dailyReport } from "../src/report/daily.ts";
import { hourlyReport } from "../src/report/hourly.ts";
import { projectReport } from "../src/report/project.ts";
import { weeklyReport } from "../src/report/weekly.ts";
import { REPORT_CONFIG, seedReportFixtures } from "./fixtures/report-golden/seed.ts";

const MIGRATION_SQL = readFileSync(
  join(import.meta.dir, "../src/db/migrations/0021_normalize_commit_dates.sql"),
  "utf8",
);

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "tempad-migration-0021-"));
}

/** What a fresh collect stores for a git date: the real parser, so the test cannot drift from it. */
function freshCollect(authoredAt: string, committedAt: string): [string, string] {
  const record = `\x1e${["a".repeat(40), "n", "e", authoredAt, committedAt, "s", ""].join("\x1f")}`;
  const [commit] = parseLogOutput(record);
  if (!commit) throw new Error("parseLogOutput returned no commit");
  return [commit.authoredAt, commit.committedAt];
}

interface Row {
  sha: string;
  authored_at: string;
  committed_at: string;
  sync_host: string | null;
  sync_updated_at: string | null;
  sync_dirty: number;
}

function snapshot(database: Database): Row[] {
  return database
    .query(
      `SELECT sha, authored_at, committed_at, sync_host, sync_updated_at, sync_dirty
         FROM gh_commits ORDER BY sha`,
    )
    .all() as Row[];
}

interface Seed {
  sha: string;
  authoredAt: string;
  committedAt: string;
  syncHost: string | null;
  syncUpdatedAt: string | null;
  syncDirty: number;
}

const PUSHED_STAMP = "2026-09-10T12:00:00.000Z";
const PENDING_STAMP = "2026-09-11T08:30:00.123Z";

/** Rows of every shape a database can hold when this migration runs. */
const SEEDS: Seed[] = [
  // Legacy, already pushed: must stay clean with its stamp.
  {
    sha: "01",
    authoredAt: "2026-09-07T23:00:00-03:00",
    committedAt: "2026-09-07T23:05:00-03:00",
    syncHost: "host-a",
    syncUpdatedAt: PUSHED_STAMP,
    syncDirty: 0,
  },
  // Legacy, never pushed: must stay dirty with its stamp and no host.
  {
    sha: "02",
    authoredAt: "2026-09-08T08:30:00+05:30",
    committedAt: "2026-09-08T08:30:00+05:30",
    syncHost: null,
    syncUpdatedAt: PENDING_STAMP,
    syncDirty: 1,
  },
  // +00:00 is an offset form, not a UTC form, so it is rewritten to Z.
  {
    sha: "03",
    authoredAt: "2026-09-08T02:00:00+00:00",
    committedAt: "2026-09-08T02:00:00+00:00",
    syncHost: null,
    syncUpdatedAt: PENDING_STAMP,
    syncDirty: 1,
  },
  // Only one of the two columns is legacy.
  {
    sha: "04",
    authoredAt: "2026-09-08T10:00:00-03:00",
    committedAt: "2026-09-08T13:00:00.000Z",
    syncHost: "host-a",
    syncUpdatedAt: PUSHED_STAMP,
    syncDirty: 0,
  },
  // A date crossing midnight UTC (and the month/year boundary).
  {
    sha: "05",
    authoredAt: "2026-12-31T22:30:00-03:00",
    committedAt: "2026-12-31T22:30:00-03:00",
    syncHost: null,
    syncUpdatedAt: null,
    syncDirty: 1,
  },
  // Already UTC, with milliseconds: not touched.
  {
    sha: "10",
    authoredAt: "2026-09-08T02:00:00.000Z",
    committedAt: "2026-09-08T02:00:01.000Z",
    syncHost: "host-a",
    syncUpdatedAt: PUSHED_STAMP,
    syncDirty: 0,
  },
  // UTC without milliseconds (older fixtures, other writers): not touched, not padded.
  {
    sha: "11",
    authoredAt: "2026-01-01T00:00:00Z",
    committedAt: "2026-01-01T00:00:00Z",
    syncHost: null,
    syncUpdatedAt: PENDING_STAMP,
    syncDirty: 1,
  },
  // An offset-shaped value SQLite cannot read: kept as is, the migration does not fail.
  {
    sha: "12",
    authoredAt: "9999-99-99T99:99:99+01:00",
    committedAt: "2026-09-08T02:00:00.000Z",
    syncHost: null,
    syncUpdatedAt: PENDING_STAMP,
    syncDirty: 1,
  },
];

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
      // The insert trigger stamps a NULL, so a NULL stamp is set afterwards (below).
      row.syncUpdatedAt ?? PENDING_STAMP,
      row.syncDirty,
    );
    // Changing the stamp is what keeps the update trigger from firing here.
    if (row.syncUpdatedAt === null) {
      database.query("UPDATE gh_commits SET sync_updated_at = NULL WHERE sha = ?").run(row.sha);
    }
  }
}

function userVersion(database: Database): number {
  return (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

describe("migration 0021_normalize_commit_dates", () => {
  test("rewrites offset-form rows to what a fresh collect writes and leaves the rest alone", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    try {
      const old = openDatabase(path, { upToVersion: 20 });
      expect(userVersion(old)).toBe(20);
      seed(old);
      old.close();

      const database = openDatabase(path);
      expect(userVersion(database)).toBe(22);
      const rows = new Map(snapshot(database).map((row) => [row.sha, row]));

      for (const original of SEEDS) {
        const row = rows.get(original.sha);
        expect(row).toBeDefined();
        if (!row) continue;
        // Every sync column survives: no restamp, no host change, no dirty flip.
        expect(row.sync_host).toBe(original.syncHost);
        expect(row.sync_updated_at).toBe(original.syncUpdatedAt);
        expect(row.sync_dirty).toBe(original.syncDirty);
      }

      const expected = (sha: string): [string, string] => {
        const original = SEEDS.find((candidate) => candidate.sha === sha);
        if (!original) throw new Error(`no seed ${sha}`);
        return freshCollect(original.authoredAt, original.committedAt);
      };
      for (const sha of ["01", "02", "03", "04", "05"]) {
        const [authoredAt, committedAt] = expected(sha);
        expect([rows.get(sha)?.authored_at, rows.get(sha)?.committed_at]).toEqual([
          authoredAt,
          committedAt,
        ]);
      }
      // Spot-check the values themselves, so the helper above cannot hide a shared mistake.
      expect(rows.get("01")?.authored_at).toBe("2026-09-08T02:00:00.000Z");
      expect(rows.get("02")?.authored_at).toBe("2026-09-08T03:00:00.000Z");
      expect(rows.get("03")?.authored_at).toBe("2026-09-08T02:00:00.000Z");
      expect(rows.get("05")?.authored_at).toBe("2027-01-01T01:30:00.000Z");

      // Rows already in UTC form, and the unreadable one, are byte-identical.
      for (const sha of ["10", "11", "12"]) {
        const original = SEEDS.find((candidate) => candidate.sha === sha);
        expect(rows.get(sha)?.authored_at).toBe(original?.authoredAt as string);
        expect(rows.get(sha)?.committed_at).toBe(original?.committedAt as string);
      }

      // No tombstone and no leftover marker from the stamp juggling.
      expect(database.query("SELECT COUNT(*) AS n FROM sync_tombstones").get()).toEqual({ n: 0 });
      expect(
        database
          .query("SELECT COUNT(*) AS n FROM gh_commits WHERE sync_updated_at LIKE '%~'")
          .get(),
      ).toEqual({ n: 0 });
      expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("running it again changes nothing", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    try {
      const old = openDatabase(path, { upToVersion: 20 });
      seed(old);
      old.close();

      const database = openDatabase(path);
      const once = snapshot(database);
      database.exec(MIGRATION_SQL);
      expect(snapshot(database)).toEqual(once);
      database.exec(MIGRATION_SQL);
      expect(snapshot(database)).toEqual(once);
      database.close();

      // Reopening is a no-op as well: the version stops it from replaying.
      const reopened = openDatabase(path);
      expect(snapshot(reopened)).toEqual(once);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an empty gh_commits table migrates cleanly", () => {
    const database = openDatabase(":memory:");
    expect(userVersion(database)).toBe(22);
    expect(snapshot(database)).toEqual([]);
    database.close();
  });

  test("a later content change still restamps and re-dirties a normalized row", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    try {
      const old = openDatabase(path, { upToVersion: 20 });
      seed(old);
      old.close();

      const database = openDatabase(path, { hostSlug: "host-b" });
      database.query("UPDATE gh_commits SET subject = 'edited' WHERE sha = '01'").run();
      const row = snapshot(database).find((candidate) => candidate.sha === "01");
      expect(row?.sync_dirty).toBe(1);
      expect(row?.sync_host).toBe("host-b");
      expect((row?.sync_updated_at ?? "") > PUSHED_STAMP).toBe(true);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("report output for an all-UTC database is identical before and after", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    const render = (database: Database): string[] => {
      const range = { from: "2026-08-31", to: "2026-09-02" };
      return [
        dailyReport.render(database, REPORT_CONFIG, range),
        hourlyReport.render(database, REPORT_CONFIG, range),
        projectReport.render(database, REPORT_CONFIG, range),
        weeklyReport.render(database, REPORT_CONFIG, range),
      ];
    };
    try {
      const old = openDatabase(path, { upToVersion: 20 });
      seedReportFixtures(old);
      const before = render(old);
      const commitsBefore = snapshot(old);
      expect(commitsBefore.length).toBeGreaterThan(0);
      old.close();

      const database = openDatabase(path);
      expect(userVersion(database)).toBe(22);
      expect(snapshot(database)).toEqual(commitsBefore);
      expect(render(database)).toEqual(before);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
