import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { LoadedConfig } from "../config/env.ts";
import { loadRules, resolveRepository } from "../config/rules.ts";
import { getSyncState, setSyncState } from "../db/sync-state.ts";
import { discoverRepositories } from "./github/discover.ts";
import { commitExists, logCommits, refsContaining } from "./github/log.ts";
import { mirrorRepository } from "./github/mirror.ts";
import { fetchFirstAuthoredAt, fetchPullRequests } from "./github/pull-requests.ts";
import type { CommandRunner } from "./github/request.ts";
import type { Collector, SyncOptions, SyncSummary } from "./types.ts";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Incremental window: re-scan from 7 days before the last sync. Reconcile only
// checks stored shas authored inside it, so an orphaned (rewritten-away) commit
// authored before the window is never deleted by a normal sync.
function lowerBound(since: string, lastSyncAt: string | undefined): string {
  if (!lastSyncAt) return since;
  return new Date(new Date(lastSyncAt).getTime() - SEVEN_DAYS_MS).toISOString();
}

export interface GithubCollectorDependencies {
  fetch: typeof fetch;
  runner: CommandRunner;
  ghCliRetryDelayMs?: number;
}

type UpsertOutcome = "inserted" | "updated" | "unchanged";

/** Rows touched by the statement that ran most recently on this connection. */
function rowChanged(database: Database): boolean {
  const row = database.query(`SELECT changes() AS changed`).get() as { changed: number };
  return row.changed > 0;
}

function upsertRepository(
  database: Database,
  fullName: string,
  org: string,
  project: string,
  meta: string | null,
  isPersonal: boolean,
  defaultBranch: string | undefined,
): void {
  database
    .query(
      `INSERT INTO gh_repos (full_name, org, is_personal, default_branch, project, meta)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(full_name) DO UPDATE SET
         default_branch = COALESCE(excluded.default_branch, gh_repos.default_branch),
         org = excluded.org,
         project = excluded.project,
         meta = excluded.meta`,
    )
    .run(fullName, org, isPersonal ? 1 : 0, defaultBranch ?? null, project, meta);
}

function setMirroredAt(database: Database, fullName: string, timestamp: string): void {
  database
    .query(`UPDATE gh_repos SET mirrored_at = ? WHERE full_name = ?`)
    .run(timestamp, fullName);
}

function upsertCommit(
  database: Database,
  repo: string,
  commit: {
    sha: string;
    branches: string[];
    authorName: string;
    authorEmail: string;
    authoredAt: string;
    committedAt: string;
    subject: string;
    body: string;
    filesChanged: number | null;
    insertions: number | null;
    deletions: number | null;
  },
): UpsertOutcome {
  const existing = database.query(`SELECT sha FROM gh_commits WHERE sha = ?`).get(commit.sha);
  // The DO UPDATE only fires when at least one stored column actually differs, so
  // `changes()` stays 0 for a re-sync of unchanged rows and `updated` reports real edits.
  database
    .query(
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
    )
    .run(
      commit.sha,
      repo,
      JSON.stringify(commit.branches),
      commit.authorName,
      commit.authorEmail,
      commit.authoredAt,
      commit.committedAt,
      commit.subject,
      commit.body,
      commit.filesChanged,
      commit.insertions,
      commit.deletions,
    );
  if (!existing) return "inserted";
  return rowChanged(database) ? "updated" : "unchanged";
}

function upsertPullRequest(
  database: Database,
  pullRequest: {
    repo: string;
    number: number;
    title: string;
    state: string;
    author: string;
    role: string;
    createdAt: string;
    mergedAt: string | null;
    closedAt: string | null;
  },
): UpsertOutcome {
  const existing = database
    .query(`SELECT number FROM gh_pull_requests WHERE repo = ? AND number = ?`)
    .get(pullRequest.repo, pullRequest.number);
  database
    .query(
      `INSERT INTO gh_pull_requests (repo, number, title, state, author, role, created_at, merged_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, number) DO UPDATE SET
         title = excluded.title,
         state = excluded.state,
         author = excluded.author,
         role = excluded.role,
         created_at = excluded.created_at,
         merged_at = excluded.merged_at,
         closed_at = excluded.closed_at
       WHERE gh_pull_requests.title IS NOT excluded.title
         OR gh_pull_requests.state IS NOT excluded.state
         OR gh_pull_requests.author IS NOT excluded.author
         OR gh_pull_requests.role IS NOT excluded.role
         OR gh_pull_requests.created_at IS NOT excluded.created_at
         OR gh_pull_requests.merged_at IS NOT excluded.merged_at
         OR gh_pull_requests.closed_at IS NOT excluded.closed_at`,
    )
    .run(
      pullRequest.repo,
      pullRequest.number,
      pullRequest.title,
      pullRequest.state,
      pullRequest.author,
      pullRequest.role,
      pullRequest.createdAt,
      pullRequest.mergedAt,
      pullRequest.closedAt,
    );
  if (!existing) return "inserted";
  return rowChanged(database) ? "updated" : "unchanged";
}

/**
 * Whether a pull request's `first_authored_at` needs (re)fetching: unset, or
 * GitHub's `updated_at` cursor moved since the last sync -- or, on `--full`,
 * unconditionally, since a full backfill must refetch every PR regardless of
 * what is already stored.
 */
function pullRequestNeedsFirstAuthoredAt(
  database: Database,
  repo: string,
  number: number,
  updatedAt: string,
  full: boolean,
): boolean {
  if (full) return true;
  const row = database
    .query(
      `SELECT first_authored_at, updated_at FROM gh_pull_requests WHERE repo = ? AND number = ?`,
    )
    .get(repo, number) as { first_authored_at: string | null; updated_at: string | null } | null;
  if (!row) return true;
  if (row.first_authored_at === null) return true;
  return row.updated_at !== updatedAt;
}

function setFirstAuthoredAt(
  database: Database,
  repo: string,
  number: number,
  firstAuthoredAt: string | null,
  updatedAt: string,
): void {
  database
    .query(
      `UPDATE gh_pull_requests SET first_authored_at = ?, updated_at = ? WHERE repo = ? AND number = ?`,
    )
    .run(firstAuthoredAt, updatedAt, repo, number);
}

export const GITHUB_NEEDS = [
  "ghUser",
  "ghOrgs",
  "ghIncludePersonal",
  "ghToken",
  "gitAuthorEmails",
  "since",
] as const;

export function createGithubCollector(
  dependencies: GithubCollectorDependencies,
): Collector<(typeof GITHUB_NEEDS)[number]> {
  return {
    name: "github",
    needs: GITHUB_NEEDS,
    async sync(
      database: Database,
      config: LoadedConfig<(typeof GITHUB_NEEDS)[number]>,
      options: SyncOptions,
    ): Promise<SyncSummary> {
      const syncStart = new Date().toISOString();
      const syncState = getSyncState(database, "github");
      const lower = lowerBound(options.since ?? config.since, syncState?.lastSyncAt);
      const fetchImplementation = options.fetch ?? dependencies.fetch;

      const requestOptions = {
        token: config.ghToken,
        fetch: fetchImplementation,
        runner: dependencies.runner,
        ghCliRetryDelayMs: dependencies.ghCliRetryDelayMs,
      };

      let inserted = 0;
      let updated = 0;
      let deleted = 0;
      const warnings: string[] = [];
      let anyMirrorFailed = false;

      const rules = loadRules(join(config.home, "tempad.toml"));

      const discovery = await discoverRepositories(
        config.ghUser,
        config.ghOrgs,
        config.ghIncludePersonal,
        lower,
        requestOptions,
      );

      for (const repository of discovery.repositories.values()) {
        const resolved = resolveRepository(rules, repository.fullName);
        upsertRepository(
          database,
          repository.fullName,
          resolved.org,
          resolved.project,
          Object.keys(resolved.meta).length > 0 ? JSON.stringify(resolved.meta) : null,
          repository.isPersonal,
          repository.defaultBranch,
        );
      }

      for (const repository of discovery.repositories.values()) {
        const mirrorResult = await mirrorRepository(
          repository.fullName,
          repository.org,
          config.home,
          dependencies.runner,
          repository.sshUrl,
        );

        if (!mirrorResult.ok) {
          warnings.push(mirrorResult.error);
          anyMirrorFailed = true;
          continue;
        }

        setMirroredAt(database, repository.fullName, new Date().toISOString());

        const commits = await logCommits(mirrorResult.path, lower, dependencies.runner);
        const matchingEmails = new Set(config.gitAuthorEmails.map((email) => email.toLowerCase()));

        for (const commit of commits) {
          if (!matchingEmails.has(commit.authorEmail.toLowerCase())) continue;

          const branches = await refsContaining(mirrorResult.path, commit.sha, dependencies.runner);
          const outcome = upsertCommit(database, repository.fullName, { ...commit, branches });
          if (outcome === "inserted") inserted++;
          else if (outcome === "updated") updated++;
        }

        const storedShas = database
          .query(`SELECT sha FROM gh_commits WHERE repo = ? AND authored_at >= ?`)
          .all(repository.fullName, lower) as { sha: string }[];

        for (const { sha } of storedShas) {
          const exists = await commitExists(mirrorResult.path, sha, dependencies.runner);
          const branches = exists
            ? await refsContaining(mirrorResult.path, sha, dependencies.runner)
            : [];
          if (!exists || branches.length === 0) {
            database.query(`DELETE FROM gh_commits WHERE sha = ?`).run(sha);
            deleted++;
          }
        }

        const authoredNumbers =
          discovery.authoredPullRequestNumbersByRepository.get(repository.fullName) ?? new Set();
        const reviewedNumbers =
          discovery.reviewedPullRequestNumbersByRepository.get(repository.fullName) ?? new Set();

        if (authoredNumbers.size > 0 || reviewedNumbers.size > 0) {
          const pullRequests = await fetchPullRequests(
            repository.fullName,
            lower,
            authoredNumbers,
            reviewedNumbers,
            requestOptions,
          );
          for (const pullRequest of pullRequests) {
            const outcome = upsertPullRequest(database, pullRequest);
            if (outcome === "inserted") inserted++;
            else if (outcome === "updated") updated++;

            if (
              pullRequestNeedsFirstAuthoredAt(
                database,
                pullRequest.repo,
                pullRequest.number,
                pullRequest.updatedAt,
                options.full ?? false,
              )
            ) {
              const firstAuthoredAt = await fetchFirstAuthoredAt(
                pullRequest.repo,
                pullRequest.number,
                requestOptions,
              );
              setFirstAuthoredAt(
                database,
                pullRequest.repo,
                pullRequest.number,
                firstAuthoredAt,
                pullRequest.updatedAt,
              );
            }
          }
        }
      }

      if (anyMirrorFailed) {
        throw new Error(
          `github sync failed: ${warnings.length} repository(ies) could not be mirrored: ${warnings.join("; ")}`,
        );
      }

      setSyncState(database, "github", syncStart);

      return { source: "github", inserted, updated, deleted, warnings };
    },
  };
}
