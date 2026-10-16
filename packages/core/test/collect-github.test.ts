import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../src/collect/github/request.ts";
import { createGithubCollector } from "../src/collect/github.ts";
import type { Config } from "../src/config/env.ts";
import { openDatabase } from "../src/db/database.ts";
import {
  addCommit,
  addCommitOnDetachedRef,
  buildRepository,
} from "./fixtures/git/build-repository.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An ISO timestamp `days` before now. A non-zero `offsetHours` renders it as
 * wall-clock time with that UTC offset (e.g. -3 -> `...-03:00`), the way git
 * stores an author date, so mixed-offset `authored_at` handling stays covered.
 */
function daysAgo(days: number, offsetHours = 0): string {
  const instant = Date.now() - days * DAY_MS;
  if (offsetHours === 0) return new Date(instant).toISOString();
  const sign = offsetHours < 0 ? "-" : "+";
  const hours = String(Math.abs(offsetHours)).padStart(2, "0");
  const wallClock = new Date(instant + offsetHours * 60 * 60 * 1000).toISOString();
  return `${wallClock.slice(0, -1)}${sign}${hours}:00`;
}

const HOUR_MS = 60 * 60 * 1000;

const NORMALIZE_COMMIT_DATES_SQL = readFileSync(
  join(import.meta.dir, "../src/db/migrations/0021_normalize_commit_dates.sql"),
  "utf8",
);

/**
 * Replays migration 0021 over rows planted after the database was opened, the way an
 * upgrade rewrites a database that was written by a release before b699db6.
 */
function migrateLegacyDates(database: Database): void {
  database.exec(NORMALIZE_COMMIT_DATES_SQL);
}

/**
 * Inserts a `gh_commits` row for a sha that is in no mirror, with `authored_at`
 * and `committed_at` in git's offset form (`...-03:00`) the way releases before
 * b699db6 stored them: the same instant as `instantMs`, rendered at `offsetHours`.
 */
function plantLegacyOrphan(
  database: Database,
  sha: string,
  instantMs: number,
  offsetHours: number,
): void {
  const sign = offsetHours < 0 ? "-" : "+";
  const wallClock = new Date(instantMs + offsetHours * HOUR_MS).toISOString().slice(0, 19);
  const stored = `${wallClock}${sign}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`;
  database
    .query(
      `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, body)
       VALUES (?, 'Mosaicstg/LiUNA-Campaigns', '["main"]', 'S', 'me@saulo.engineer', ?, ?, 'orphan', NULL)`,
    )
    .run(sha, stored, stored);
}

const FIXTURES_DIR = join(import.meta.dir, "fixtures/github");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function baseConfig(home: string): Config {
  return {
    mondayApiToken: "token",
    mondayUser: "1",
    ghUser: "svallory",
    ghOrgs: ["Mosaicstg"],
    ghIncludePersonal: false,
    ghToken: "gh-token",
    gitAuthorEmails: ["me@saulo.engineer"],
    claudeDirs: [],
    hostSlug: "test-host",
    tz: "America/Sao_Paulo",
    since: "2026-08-01",
    syncToken: "unused",
    home,
  };
}

function makeRunner(mirrorRoot: { source: string | undefined }): CommandRunner {
  return {
    async run(argv, cwd) {
      const [bin, ...args] = argv;
      if (bin !== "git") {
        return { code: 1, stdout: "", stderr: `unexpected command: ${argv.join(" ")}` };
      }
      if (args[0] === "clone" && args[1] === "--mirror") {
        const source = mirrorRoot.source;
        if (!source) return { code: 1, stdout: "", stderr: "no source configured" };
        const dest = args[3] as string;
        const proc = Bun.spawn(["git", "clone", "--mirror", source, dest], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const code = await proc.exited;
        return {
          code,
          stdout: "",
          stderr: code === 0 ? "" : await new Response(proc.stderr).text(),
        };
      }

      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return { code, stdout, stderr };
    },
  };
}

function makeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/search/commits")) {
      return jsonResponse(loadFixture("search-commits.json"));
    }
    if (url.includes("reviewed-by")) {
      return jsonResponse(loadFixture("search-issues-reviewed.json"));
    }
    if (url.includes("/search/issues")) {
      return jsonResponse(loadFixture("search-issues-authored.json"));
    }
    if (url.includes("/pulls/") && url.includes("/commits")) {
      return jsonResponse(loadFixture("pull-commits.json"));
    }
    if (url.includes("/pulls")) {
      return jsonResponse(loadFixture("pulls.json"));
    }
    return jsonResponse({ items: [], total_count: 0 });
  }) as typeof fetch;
}

describe("github collector", () => {
  test("a second sync immediately after the first is fully idempotent across timezone offsets", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "commit with non-UTC offset",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-02T22:00:00-03:00",
        files: { "readme.md": "hello" },
      },
      {
        message: "another commit with non-UTC offset",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-03T23:30:00-03:00",
        files: { "other.md": "hi" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);
      const mirrorRoot = { source: sourceDirectory };
      const collector = createGithubCollector({
        fetch: makeFetch(),
        runner: makeRunner(mirrorRoot),
      });

      const firstSummary = await collector.sync(database, config, {});
      expect(firstSummary.deleted).toBe(0);

      const commitRows = database
        .query("SELECT sha, authored_at FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { sha: string; authored_at: string }[];
      expect(commitRows.length).toBe(2);
      for (const row of commitRows) {
        expect(row.authored_at.endsWith("Z")).toBe(true);
      }

      const secondSummary = await collector.sync(database, config, {});
      expect(secondSummary.inserted).toBe(0);
      expect(secondSummary.deleted).toBe(0);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("a commit reachable only from refs/pull/N/head is kept and does not flap", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "commit on main",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-02T10:00:00-03:00",
        files: { "readme.md": "hello" },
      },
    ]);

    try {
      // Reachable only from refs/pull/1/head: `git log --all` sees it, but
      // `git branch -a --contains` does not. Before the reachability fix, this
      // commit was inserted by collection and deleted by reconcile every run.
      const pullRequestSha = await addCommitOnDetachedRef(sourceDirectory, "refs/pull/1/head", {
        message: "commit only on a PR ref",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-03T11:00:00-03:00",
        files: { "pull-request.md": "from a pull request" },
      });

      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);
      const collector = createGithubCollector({
        fetch: makeFetch(),
        runner: makeRunner({ source: sourceDirectory }),
      });

      const firstSummary = await collector.sync(database, config, {});
      expect(firstSummary.deleted).toBe(0);

      const storedRow = database
        .query("SELECT branches FROM gh_commits WHERE sha = ?")
        .get(pullRequestSha) as { branches: string } | null;
      expect(storedRow).not.toBeNull();
      // `branches` holds short ref names from `for-each-ref --format=%(refname:short)`.
      expect(JSON.parse(storedRow?.branches ?? "[]")).toContain("pull/1/head");

      const secondSummary = await collector.sync(database, config, {});
      expect(secondSummary.inserted).toBe(0);
      expect(secondSummary.updated).toBe(0);
      expect(secondSummary.deleted).toBe(0);

      const stillStored = database
        .query("SELECT sha FROM gh_commits WHERE sha = ?")
        .get(pullRequestSha);
      expect(stillStored).not.toBeNull();

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("discovers, mirrors, logs commits, records PRs, and is idempotent", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "initial commit",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-02T10:00:00-03:00",
        files: { "readme.md": "hello" },
      },
      {
        message: "second commit",
        authorName: "Someone Else",
        authorEmail: "someone@example.com",
        date: "2026-09-03T10:00:00-03:00",
        files: { "other.md": "hi" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);
      const mirrorRoot = { source: sourceDirectory };
      const collector = createGithubCollector({
        fetch: makeFetch(),
        runner: makeRunner(mirrorRoot),
      });

      const firstSummary = await collector.sync(database, config, {});

      expect(firstSummary.source).toBe("github");
      expect(firstSummary.inserted).toBeGreaterThan(0);
      expect(firstSummary.warnings).toEqual([]);

      const commitRows = database
        .query("SELECT sha, author_email FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { sha: string; author_email: string }[];
      expect(commitRows.length).toBe(1);
      expect(commitRows[0]?.author_email).toBe("me@saulo.engineer");

      const pullRequestRows = database
        .query("SELECT number, role, state, first_authored_at FROM gh_pull_requests WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as {
        number: number;
        role: string;
        state: string;
        first_authored_at: string | null;
      }[];
      expect(pullRequestRows).toEqual([
        { number: 42, role: "author", state: "merged", first_authored_at: "2026-08-19T09:00:00Z" },
      ]);

      const secondSummary = await collector.sync(database, config, {});
      expect(secondSummary.inserted).toBe(0);
      expect(secondSummary.deleted).toBe(0);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("a PR's first_authored_at is only refetched when its updated_at cursor moves", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "initial commit",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-02T10:00:00-03:00",
        files: { "readme.md": "hello" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);
      const mirrorRoot = { source: sourceDirectory };

      let commitsCalls = 0;
      const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/pulls/") && url.includes("/commits")) {
          commitsCalls++;
          return jsonResponse(loadFixture("pull-commits.json"));
        }
        if (url.includes("/search/commits"))
          return jsonResponse(loadFixture("search-commits.json"));
        if (url.includes("reviewed-by"))
          return jsonResponse(loadFixture("search-issues-reviewed.json"));
        if (url.includes("/search/issues"))
          return jsonResponse(loadFixture("search-issues-authored.json"));
        if (url.includes("/pulls")) return jsonResponse(loadFixture("pulls.json"));
        return jsonResponse({ items: [], total_count: 0 });
      }) as typeof fetch;

      const collector = createGithubCollector({ fetch: fetchImpl, runner: makeRunner(mirrorRoot) });

      await collector.sync(database, config, {});
      expect(commitsCalls).toBe(1);

      // Same fixture, same updated_at: a second sync must not re-fetch commits.
      await collector.sync(database, config, {});
      expect(commitsCalls).toBe(1);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("--full refetches first_authored_at for every PR, ignoring the stored updated_at cursor", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "initial commit",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-02T10:00:00-03:00",
        files: { "readme.md": "hello" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);
      const mirrorRoot = { source: sourceDirectory };

      let commitsCalls = 0;
      const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/pulls/") && url.includes("/commits")) {
          commitsCalls++;
          return jsonResponse(loadFixture("pull-commits.json"));
        }
        if (url.includes("/search/commits"))
          return jsonResponse(loadFixture("search-commits.json"));
        if (url.includes("reviewed-by"))
          return jsonResponse(loadFixture("search-issues-reviewed.json"));
        if (url.includes("/search/issues"))
          return jsonResponse(loadFixture("search-issues-authored.json"));
        if (url.includes("/pulls")) return jsonResponse(loadFixture("pulls.json"));
        return jsonResponse({ items: [], total_count: 0 });
      }) as typeof fetch;

      const collector = createGithubCollector({ fetch: fetchImpl, runner: makeRunner(mirrorRoot) });

      // Incremental sync: first run fetches once, a second unchanged run fetches zero more times.
      await collector.sync(database, config, {});
      expect(commitsCalls).toBe(1);
      await collector.sync(database, config, {});
      expect(commitsCalls).toBe(1);

      // --full: the CLI clears sync_state before calling the collector, widening
      // `lower` back to `config.since`; the PR's updated_at cursor has not moved,
      // but the `full` option must still force a refetch for every PR.
      database.query("DELETE FROM sync_state WHERE source = ?").run("github");
      await collector.sync(database, config, { full: true });
      expect(commitsCalls).toBe(2);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("reconcile deletes rows for shas no longer reachable after history rewrite", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    // Reconcile only inspects shas authored inside the incremental window
    // (`lastSyncAt` minus 7 days), so dates must be relative to now: the old
    // absolute 2026-09-03T13:00Z date fell out of the window once now - 7d
    // passed it (2026-09-10T13:00Z).
    const sourceDirectory = await buildRepository([
      {
        message: "keep me",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: daysAgo(3),
        files: { "a.md": "a" },
      },
      {
        message: "will be rewritten",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: daysAgo(2, -3),
        files: { "b.md": "b" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);
      const mirrorRoot = { source: sourceDirectory };
      const runner = makeRunner(mirrorRoot);
      const collector = createGithubCollector({ fetch: makeFetch(), runner });

      await collector.sync(database, config, {});

      const before = database
        .query("SELECT sha FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { sha: string }[];
      expect(before.length).toBe(2);

      await runner.run(["git", "reset", "--hard", "HEAD~1"], sourceDirectory);
      await addCommit(sourceDirectory, {
        message: "replacement commit",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: daysAgo(1),
        files: { "c.md": "c" },
      });

      const summary = await collector.sync(database, config, {});
      expect(summary.deleted).toBe(1);

      const after = database
        .query("SELECT sha FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { sha: string }[];
      expect(after.length).toBe(2);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("reconcile leaves rows authored before the incremental window alone after a history rewrite", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const author = { authorName: "Saulo Vallory", authorEmail: "me@saulo.engineer" };
    const sourceDirectory = await buildRepository([
      { ...author, message: "keep me", date: daysAgo(31), files: { "a.md": "a" } },
      { ...author, message: "old, will be rewritten", date: daysAgo(30), files: { "b.md": "b" } },
    ]);

    try {
      const database = openDatabase(join(homeDirectory, "tempad.db"));
      const config = baseConfig(homeDirectory);
      const runner = makeRunner({ source: sourceDirectory });
      const collector = createGithubCollector({ fetch: makeFetch(), runner });

      await collector.sync(database, config, {});

      await runner.run(["git", "reset", "--hard", "HEAD~1"], sourceDirectory);
      await addCommit(sourceDirectory, {
        ...author,
        message: "replacement commit",
        date: daysAgo(1),
        files: { "c.md": "c" },
      });

      // The second sync's window starts 7 days before the first sync, so the
      // 30-day-old orphan is never re-checked: see `lowerBound` in collect/github.ts.
      const summary = await collector.sync(database, config, {});
      expect(summary.deleted).toBe(0);

      const count = database
        .query("SELECT COUNT(*) AS n FROM gh_commits WHERE repo = ?")
        .get("Mosaicstg/LiUNA-Campaigns") as { n: number };
      expect(count.n).toBe(3);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("reconcile after 0021: a legacy offset-form row is in or out of the window by its real time", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const author = { authorName: "Saulo Vallory", authorEmail: "me@saulo.engineer" };
    const sourceDirectory = await buildRepository([
      { ...author, message: "live", date: daysAgo(1), files: { "a.md": "a" } },
    ]);

    try {
      const database = openDatabase(join(homeDirectory, "tempad.db"));
      const config = baseConfig(homeDirectory);
      const collector = createGithubCollector({
        fetch: makeFetch(),
        runner: makeRunner({ source: sourceDirectory }),
      });
      await collector.sync(database, config, {});

      // Pin the window so both planted rows sit one hour either side of its lower bound.
      const lastSyncMs = Math.floor((Date.now() - DAY_MS) / 1000) * 1000;
      database
        .query("UPDATE sync_state SET last_sync_at = ? WHERE source = 'github'")
        .run(new Date(lastSyncMs).toISOString());
      const lowerMs = lastSyncMs - 7 * DAY_MS;
      // Orphans as a pre-b699db6 release stored them (see `plantLegacyOrphan`). Left in
      // offset form, -03:00 wall clock sorts BELOW the UTC bound although the instant is
      // inside the window, and +09:00 sorts ABOVE it although the instant is outside;
      // 0021 puts both on the instant, and reconcile compares text from there.
      plantLegacyOrphan(database, "1".repeat(40), lowerMs + HOUR_MS, -3);
      plantLegacyOrphan(database, "2".repeat(40), lowerMs - HOUR_MS, 9);
      migrateLegacyDates(database);

      const summary = await collector.sync(database, config, {});
      expect(summary.deleted).toBe(1);

      const survivors = (
        database.query("SELECT sha FROM gh_commits WHERE subject = 'orphan'").all() as {
          sha: string;
        }[]
      ).map((row) => row.sha);
      expect(survivors).toEqual(["2".repeat(40)]);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("reconcile after 0021 with a date-only `since` bound reads it as UTC midnight", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const author = { authorName: "Saulo Vallory", authorEmail: "me@saulo.engineer" };
    const sourceDirectory = await buildRepository([
      { ...author, message: "live", date: daysAgo(1), files: { "a.md": "a" } },
    ]);

    try {
      const database = openDatabase(join(homeDirectory, "tempad.db"));
      const config = baseConfig(homeDirectory); // since: "2026-08-01"
      const collector = createGithubCollector({
        fetch: makeFetch(),
        runner: makeRunner({ source: sourceDirectory }),
      });
      await collector.sync(database, config, {});

      // No sync_state: the window starts at `since` itself, a bare date.
      database.query("DELETE FROM sync_state WHERE source = 'github'").run();
      const sinceMs = Date.parse("2026-08-01T00:00:00.000Z");
      plantLegacyOrphan(database, "1".repeat(40), sinceMs + HOUR_MS, -3); // 2026-07-31T22:00-03:00
      plantLegacyOrphan(database, "2".repeat(40), sinceMs - HOUR_MS, 9); // 2026-08-01T08:00+09:00
      migrateLegacyDates(database);

      const summary = await collector.sync(database, config, {});
      expect(summary.deleted).toBe(1);
      const survivors = (
        database.query("SELECT sha FROM gh_commits WHERE subject = 'orphan'").all() as {
          sha: string;
        }[]
      ).map((row) => row.sha);
      expect(survivors).toEqual(["2".repeat(40)]);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("rate limit: retries on 403 with Retry-After, fails after exhausting retries", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);

      let callCount = 0;
      const succeedAfterTwo: typeof fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/search/commits")) {
          callCount++;
          if (callCount <= 2) {
            return new Response("rate limited", {
              status: 403,
              headers: { "Retry-After": "0" },
            });
          }
          return jsonResponse(loadFixture("search-commits.json"));
        }
        if (url.includes("reviewed-by"))
          return jsonResponse(loadFixture("search-issues-reviewed.json"));
        if (url.includes("/search/issues"))
          return jsonResponse(loadFixture("search-issues-authored.json"));
        if (url.includes("/pulls/") && url.includes("/commits"))
          return jsonResponse(loadFixture("pull-commits.json"));
        if (url.includes("/pulls")) return jsonResponse(loadFixture("pulls.json"));
        return jsonResponse({ items: [], total_count: 0 });
      }) as typeof fetch;

      const noopRunner: CommandRunner = {
        async run() {
          return { code: 0, stdout: "", stderr: "" };
        },
      };

      const collector = createGithubCollector({ fetch: succeedAfterTwo, runner: noopRunner });
      const summary = await collector.sync(database, config, {});
      expect(summary.source).toBe("github");
      expect(callCount).toBe(3);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
    }
  });

  test("rate limit: fails the source after three retries", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);

      const alwaysRateLimited: typeof fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/search/commits")) {
          return new Response("rate limited", { status: 403, headers: { "Retry-After": "0" } });
        }
        return jsonResponse({ items: [], total_count: 0 });
      }) as typeof fetch;

      const noopRunner: CommandRunner = {
        async run() {
          return { code: 0, stdout: "", stderr: "" };
        },
      };

      const collector = createGithubCollector({ fetch: alwaysRateLimited, runner: noopRunner });
      await expect(collector.sync(database, config, {})).rejects.toThrow(/rate limit/i);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
    }
  });

  test("a repo discovered only via reviewed-by search is still mirrored and its commits collected", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "reviewed repo commit",
        authorName: "Someone Else",
        authorEmail: "someone@example.com",
        date: "2026-09-02T10:00:00-03:00",
        files: { "x.md": "x" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = { ...baseConfig(homeDirectory), gitAuthorEmails: ["someone@example.com"] };

      const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/search/commits")) {
          return jsonResponse({ total_count: 0, items: [] });
        }
        if (url.includes("reviewed-by")) {
          return jsonResponse(loadFixture("search-issues-reviewed-only-repo.json"));
        }
        if (url.includes("/search/issues")) {
          return jsonResponse({ total_count: 0, items: [] });
        }
        if (url.includes("/pulls/") && url.includes("/commits")) {
          return jsonResponse(loadFixture("pull-commits.json"));
        }
        if (url.includes("/pulls")) {
          return jsonResponse(loadFixture("pulls-only-reviewed.json"));
        }
        return jsonResponse({ items: [], total_count: 0 });
      }) as typeof fetch;

      const runner = makeRunner({ source: sourceDirectory });
      const collector = createGithubCollector({ fetch: fetchImpl, runner });

      const summary = await collector.sync(database, config, {});

      expect(summary.warnings).toEqual([]);

      const repoRow = database
        .query("SELECT full_name, mirrored_at FROM gh_repos WHERE full_name = ?")
        .get("Mosaicstg/only-reviewed") as { full_name: string; mirrored_at: string | null } | null;
      expect(repoRow?.mirrored_at).not.toBeNull();

      const commitRows = database
        .query("SELECT sha FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/only-reviewed") as { sha: string }[];
      expect(commitRows.length).toBe(1);

      const pullRequestRows = database
        .query("SELECT number, role FROM gh_pull_requests WHERE repo = ?")
        .all("Mosaicstg/only-reviewed") as { number: number; role: string }[];
      expect(pullRequestRows).toEqual([{ number: 7, role: "reviewer" }]);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("one repo failing to mirror does not block commits/PRs for other repos, and is warned", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    const sourceDirectory = await buildRepository([
      {
        message: "good repo commit",
        authorName: "Saulo Vallory",
        authorEmail: "me@saulo.engineer",
        date: "2026-09-02T10:00:00-03:00",
        files: { "readme.md": "hello" },
      },
    ]);

    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = baseConfig(homeDirectory);

      const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/search/commits")) {
          return jsonResponse({
            total_count: 2,
            items: [
              { repository: { full_name: "Mosaicstg/broken-repo" } },
              { repository: { full_name: "Mosaicstg/LiUNA-Campaigns" } },
            ],
          });
        }
        if (url.includes("reviewed-by")) return jsonResponse({ total_count: 0, items: [] });
        if (url.includes("/search/issues"))
          return jsonResponse(loadFixture("search-issues-authored.json"));
        if (url.includes("/pulls/") && url.includes("/commits"))
          return jsonResponse(loadFixture("pull-commits.json"));
        if (url.includes("/pulls")) return jsonResponse(loadFixture("pulls.json"));
        return jsonResponse({ items: [], total_count: 0 });
      }) as typeof fetch;

      const runner: CommandRunner = {
        async run(argv, cwd) {
          if (
            argv[0] === "git" &&
            argv[1] === "clone" &&
            argv.some((arg) => arg.includes("broken-repo.git"))
          ) {
            return { code: 1, stdout: "", stderr: "simulated clone failure" };
          }
          return makeRunner({ source: sourceDirectory }).run(argv, cwd);
        },
      };

      const collector = createGithubCollector({ fetch: fetchImpl, runner });

      await expect(collector.sync(database, config, {})).rejects.toThrow(/could not be mirrored/i);

      const commitRows = database
        .query("SELECT sha FROM gh_commits WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { sha: string }[];
      expect(commitRows.length).toBe(1);

      const pullRequestRows = database
        .query("SELECT number FROM gh_pull_requests WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { number: number }[];
      expect(pullRequestRows).toEqual([{ number: 42 }]);

      const brokenRepoRow = database
        .query("SELECT mirrored_at FROM gh_repos WHERE full_name = ?")
        .get("Mosaicstg/broken-repo") as { mirrored_at: string | null } | null;
      expect(brokenRepoRow?.mirrored_at).toBeNull();

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("gh CLI fallback retries on secondary rate limit stderr, then succeeds", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = { ...baseConfig(homeDirectory), ghToken: undefined };

      let searchCommitsCalls = 0;
      const runner: CommandRunner = {
        async run(argv) {
          const fullPath = argv[2] ?? "";
          if (typeof fullPath === "string" && fullPath.includes("/search/commits")) {
            searchCommitsCalls++;
            if (searchCommitsCalls <= 2) {
              return {
                code: 1,
                stdout: "",
                stderr: "gh: You have exceeded a secondary rate limit. (HTTP 403)",
              };
            }
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-commits.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("reviewed-by")) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-issues-reviewed.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("/search/issues")) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-issues-authored.json")),
              stderr: "",
            };
          }
          if (
            typeof fullPath === "string" &&
            fullPath.includes("/pulls/") &&
            fullPath.includes("/commits")
          ) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("pull-commits.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("/pulls")) {
            return { code: 0, stdout: JSON.stringify(loadFixture("pulls.json")), stderr: "" };
          }
          return { code: 0, stdout: JSON.stringify({ items: [], total_count: 0 }), stderr: "" };
        },
      };

      const noopFetch: typeof fetch = (async () =>
        jsonResponse({ items: [], total_count: 0 })) as unknown as typeof fetch;
      const collector = createGithubCollector({ fetch: noopFetch, runner, ghCliRetryDelayMs: 0 });

      const summary = await collector.sync(database, config, {});

      expect(searchCommitsCalls).toBe(3);
      expect(summary.source).toBe("github");

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
    }
  });

  test("gh CLI fallback retries when a call succeeds (code 0) but returns unparseable output", async () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "tempad-home-"));
    try {
      const dbPath = join(homeDirectory, "tempad.db");
      const database = openDatabase(dbPath);
      const config = { ...baseConfig(homeDirectory), ghToken: undefined };

      let pullsCalls = 0;
      const runner: CommandRunner = {
        async run(argv) {
          const fullPath = argv[2] ?? "";
          if (typeof fullPath === "string" && fullPath.includes("/search/commits")) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-commits.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("reviewed-by")) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-issues-reviewed.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("/search/issues")) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("search-issues-authored.json")),
              stderr: "",
            };
          }
          if (
            typeof fullPath === "string" &&
            fullPath.includes("/pulls/") &&
            fullPath.includes("/commits")
          ) {
            return {
              code: 0,
              stdout: JSON.stringify(loadFixture("pull-commits.json")),
              stderr: "",
            };
          }
          if (typeof fullPath === "string" && fullPath.includes("/pulls")) {
            pullsCalls++;
            if (pullsCalls <= 2) {
              return { code: 0, stdout: "", stderr: "" };
            }
            return { code: 0, stdout: JSON.stringify(loadFixture("pulls.json")), stderr: "" };
          }
          return { code: 0, stdout: JSON.stringify({ items: [], total_count: 0 }), stderr: "" };
        },
      };

      const noopFetch: typeof fetch = (async () =>
        jsonResponse({ items: [], total_count: 0 })) as unknown as typeof fetch;
      const collector = createGithubCollector({ fetch: noopFetch, runner, ghCliRetryDelayMs: 0 });

      const summary = await collector.sync(database, config, {});

      expect(pullsCalls).toBe(3);
      const pullRequestRows = database
        .query("SELECT number FROM gh_pull_requests WHERE repo = ?")
        .all("Mosaicstg/LiUNA-Campaigns") as { number: number }[];
      expect(pullRequestRows).toEqual([{ number: 42 }]);
      expect(summary.warnings).toEqual([]);

      database.close();
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
    }
  });
});
