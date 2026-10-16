import type { CommandRunner } from "./request.ts";

export interface CommitRecord {
  sha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  subject: string;
  body: string;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
}

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const LOG_FORMAT = ["%H", "%an", "%ae", "%aI", "%cI", "%s", "%b"].join(FIELD_SEP);

export function toUtcIso(dateString: string): string {
  return new Date(dateString).toISOString();
}

// What git's %aI / %cI emit for a non-UTC author: a colon-separated numeric offset.
// Mirrors the GLOB in migration 0021_normalize_commit_dates.sql.
const OFFSET_SUFFIX = /[-+]\d{2}:\d{2}$/;

/**
 * Rewrites a legacy offset-form timestamp (`2026-09-07T23:00:00-03:00`) to the UTC
 * form the collector writes (`2026-09-08T02:00:00.000Z`). Anything else, including a
 * value that ends in an offset but does not parse, is returned as it came.
 */
export function normalizeOffsetTimestamp(value: string): string {
  if (!OFFSET_SUFFIX.test(value)) return value;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? value : instant.toISOString();
}

function parseShortstat(line: string | undefined): {
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
} {
  if (!line) return { filesChanged: null, insertions: null, deletions: null };

  const filesMatch = line.match(/(\d+) files? changed/);
  const insertionsMatch = line.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = line.match(/(\d+) deletions?\(-\)/);

  return {
    filesChanged: filesMatch?.[1] ? Number.parseInt(filesMatch[1], 10) : null,
    insertions: insertionsMatch?.[1] ? Number.parseInt(insertionsMatch[1], 10) : null,
    deletions: deletionsMatch?.[1] ? Number.parseInt(deletionsMatch[1], 10) : null,
  };
}

export function parseLogOutput(output: string): CommitRecord[] {
  const records = output
    .split(RECORD_SEP)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const commits: CommitRecord[] = [];
  for (const record of records) {
    const lines = record.split("\n");
    const headerLine = lines[0] ?? "";
    const fields = headerLine.split(FIELD_SEP);
    const [sha, authorName, authorEmail, authoredAt, committedAt, subject] = fields;
    if (!sha) continue;

    const bodyAndStat = lines.slice(1).join("\n");
    const shortstatMatch = bodyAndStat.match(/^\s*(\d+ files? changed.*)$/m);
    const body = shortstatMatch
      ? bodyAndStat.slice(0, shortstatMatch.index).trim()
      : bodyAndStat.trim();
    const stat = parseShortstat(shortstatMatch?.[1]);

    commits.push({
      sha,
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authoredAt: authoredAt ? toUtcIso(authoredAt) : "",
      committedAt: committedAt ? toUtcIso(committedAt) : "",
      subject: subject ?? "",
      body,
      ...stat,
    });
  }
  return commits;
}

export async function logCommits(
  mirrorDirectory: string,
  since: string,
  runner: CommandRunner,
): Promise<CommitRecord[]> {
  const result = await runner.run(
    [
      "git",
      "log",
      "--all",
      "--no-merges",
      `--since=${since}`,
      "--date=iso-strict",
      `--format=${RECORD_SEP}${LOG_FORMAT}`,
      "--shortstat",
    ],
    mirrorDirectory,
  );
  if (result.code !== 0) {
    throw new Error(`git log failed in ${mirrorDirectory}: ${result.stderr}`);
  }

  // git's --since is a traversal-stopping heuristic per ref, not a strict filter:
  // with --all across branches whose history isn't strictly chronological
  // (rebases, cherry-picks, long-lived branches), it can still return commits
  // authored well before the cutoff. Filter strictly here instead of trusting it.
  const sinceMs = new Date(since).getTime();
  return parseLogOutput(result.stdout).filter(
    (commit) => new Date(commit.authoredAt).getTime() >= sinceMs,
  );
}

// Reachability policy: collection runs `git log --all`, which traverses EVERY ref
// a `git clone --mirror` fetched -- branches, tags, and GitHub's `refs/pull/N/head`.
// `git branch -a --contains` only reports branches, so a commit living solely on a
// PR ref looked unreachable to reconcile and was deleted right after being inserted
// (the 85-sha delete/reinsert flap: e.g. pubflow 865bbe7 is contained only by
// refs/pull/68/head). We keep those commits -- a pushed PR branch is real authored
// work even after the source branch is gone -- so reachability is decided with
// `git for-each-ref --contains`, matching the full ref set `--all` collects.
// `branches` therefore stores short names of all containing refs, not just branches.
export async function refsContaining(
  mirrorDirectory: string,
  sha: string,
  runner: CommandRunner,
): Promise<string[]> {
  const result = await runner.run(
    ["git", "for-each-ref", "--contains", sha, "--format=%(refname:short)"],
    mirrorDirectory,
  );
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function commitExists(
  mirrorDirectory: string,
  sha: string,
  runner: CommandRunner,
): Promise<boolean> {
  const result = await runner.run(["git", "cat-file", "-e", sha], mirrorDirectory);
  return result.code === 0;
}
