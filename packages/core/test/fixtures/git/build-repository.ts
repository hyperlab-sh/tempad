import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommitSpec {
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  files: Record<string, string>;
}

async function run(argv: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${argv.join(" ")} failed in ${cwd}: ${stderr}`);
  }
}

export async function buildRepository(commits: CommitSpec[]): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "tempad-git-fixture-"));
  await run(["git", "init", "--initial-branch=main"], directory);
  await run(["git", "config", "user.name", "fixture"], directory);
  await run(["git", "config", "user.email", "fixture@example.com"], directory);

  for (const commit of commits) {
    await addCommit(directory, commit);
  }

  return directory;
}

export async function addCommit(directory: string, commit: CommitSpec): Promise<void> {
  for (const [path, content] of Object.entries(commit.files)) {
    await Bun.write(join(directory, path), content);
  }
  await run(["git", "add", "-A"], directory);
  await run(
    [
      "git",
      "commit",
      "-m",
      commit.message,
      "--author",
      `${commit.authorName} <${commit.authorEmail}>`,
    ],
    directory,
    {
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_DATE: commit.date,
    },
  );
}

export async function mirrorRepository(
  sourceDirectory: string,
  mirrorDirectory: string,
): Promise<void> {
  await run(["git", "clone", "--mirror", sourceDirectory, mirrorDirectory], tmpdir());
}

export async function updateMirror(mirrorDirectory: string): Promise<void> {
  await run(["git", "remote", "update", "--prune"], mirrorDirectory);
}

/**
 * Commits on `branchName`, points `refName` at the result, then deletes the branch —
 * leaving the new commit reachable only from `refName`. Mirrors how GitHub keeps
 * `refs/pull/N/head` alive after a PR's source branch is gone.
 */
export async function addCommitOnDetachedRef(
  directory: string,
  refName: string,
  commit: CommitSpec,
): Promise<string> {
  const branchName = `tempad-fixture-${refName.replace(/[^a-zA-Z0-9]/g, "-")}`;
  await run(["git", "checkout", "-b", branchName], directory);
  await addCommit(directory, commit);

  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: directory,
    env: process.env,
    stdout: "pipe",
  });
  const sha = (await new Response(proc.stdout).text()).trim();
  await proc.exited;

  await run(["git", "update-ref", refName, sha], directory);
  await run(["git", "checkout", "main"], directory);
  await run(["git", "branch", "-D", branchName], directory);
  return sha;
}
