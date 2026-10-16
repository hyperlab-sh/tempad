import type { Database } from "bun:sqlite";
import type { LoadedConfig } from "../config/env.ts";
import { type ImpactRow, queryImpacts } from "../intent/api.ts";
import { formatEvidenceRef } from "../intent/evidence-ref.ts";
import { projectLabel } from "./format.ts";
import {
  attributeNonClaudeEvidence,
  type NonClaudeEvidenceRow,
  queryQuests,
  querySideQuests,
  queryStints,
  resolveIntentDatabase,
} from "./intent-queries.ts";
import { elapsedLabel, heading, localDateTime, table } from "./markdown.ts";
import {
  type CommitRow,
  type PullRequestRow,
  queryCommits,
  queryMondayItems,
  queryPullRequestsByRepo,
  querySessions,
  type SessionRow,
} from "./queries.ts";
import type { Report, ReportOptions } from "./types.ts";

function minutesLabel(totalMinutes: number): string {
  const rounded = Math.round(totalMinutes);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return `${hours}h ${minutes}m`;
}

interface ProjectKey {
  org: string;
  project: string;
}

function projectKeyString(key: ProjectKey): string {
  return `${key.org}/${key.project}`;
}

// `gh_commits.branches` holds the short name of every ref containing the commit,
// which in a mirror clone includes tags and GitHub's `pull/N/head` refs. Neither
// names a branch someone worked on, so they are only used when nothing else is
// left -- a commit whose source branch was deleted after its PR merged still has
// to report something.
function isWorkingBranch(ref: string): boolean {
  return !ref.startsWith("pull/") && !ref.startsWith("tags/");
}

function inferBranch(branchesJson: string): string {
  const branches = JSON.parse(branchesJson) as string[];
  const working = branches.filter(isWorkingBranch);
  const candidates = working.length > 0 ? working : branches;
  const nonDefault = candidates.filter((branch) => branch !== "main" && branch !== "dev");
  const preferred = nonDefault.length > 0 ? nonDefault : candidates;
  return preferred.reduce(
    (longest, current) => (current.length > longest.length ? current : longest),
    preferred[0] ?? "unknown",
  );
}

function render(database: Database, config: LoadedConfig<"tz">, options: ReportOptions): string {
  const range = {
    from: options.from,
    to: options.to,
    timeZone: config.tz,
    org: options.org,
    project: options.project,
    client: options.client,
  };
  const intentDatabase = resolveIntentDatabase(database, options.asOf);

  const commits = queryCommits(database, range);
  const sessions = querySessions(database, range);
  const mondayItems = queryMondayItems(database, range);
  const quests = queryQuests(intentDatabase, range);
  const sideQuests = querySideQuests(intentDatabase, range);
  const stints = queryStints(intentDatabase, range);
  const attribution = new Map(
    attributeNonClaudeEvidence(intentDatabase, range).map((row) => [row.id, row]),
  );
  const impactSubjects = [
    ...commits.map((row) => formatEvidenceRef({ kind: "commit", sha: row.sha })),
    ...mondayItems.map((row) => formatEvidenceRef({ kind: "monday", itemId: String(row.id) })),
  ];
  const impacts = queryImpacts(intentDatabase, impactSubjects);

  const keys = new Map<string, ProjectKey>();
  for (const row of [...commits, ...sessions, ...mondayItems]) {
    keys.set(projectKeyString({ org: row.org, project: row.project }), {
      org: row.org,
      project: row.project,
    });
  }
  for (const row of [...quests, ...sideQuests]) {
    if (!row.org || !row.project) continue;
    keys.set(projectKeyString({ org: row.org, project: row.project }), {
      org: row.org,
      project: row.project,
    });
  }

  const sortedKeys = [...keys.values()].sort((a, b) =>
    projectKeyString(a).localeCompare(projectKeyString(b)),
  );

  const titleSuffix = options.asOf ? ` (as of ${options.asOf})` : "";
  const sections: string[] = [
    heading(1, `project report ${options.from} to ${options.to}${titleSuffix}`),
  ];

  for (const key of sortedKeys) {
    const projectCommits = commits.filter(
      (row) => row.org === key.org && row.project === key.project,
    );
    const projectSessions = sessions.filter(
      (row) => row.org === key.org && row.project === key.project,
    );
    const projectMondayItems = mondayItems.filter(
      (row) => row.org === key.org && row.project === key.project,
    );
    const projectQuests = quests.filter(
      (row) => row.org === key.org && row.project === key.project,
    );
    const projectSideQuests = sideQuests.filter(
      (row) => row.org === key.org && row.project === key.project,
    );

    const questRows: string[][] = projectQuests.map((quest) => {
      const base = quest.confirmed ? quest.title : `${quest.title} [unconfirmed]`;
      const title = quest.originKind !== "declared" ? `${base} (inferred)` : base;
      return [
        title,
        localDateTime(quest.firstEvidence, range.timeZone),
        localDateTime(quest.lastEvidence, range.timeZone),
        elapsedLabel(quest.firstEvidence, quest.lastEvidence),
        "-",
        "-",
        String(quest.stints),
        minutesLabel(quest.sideQuestMinutes),
      ];
    });

    const otherRows: string[][] = (
      projectMondayItems.length > 0
        ? projectMondayItems.map((item) => {
            const first = item.timelineStart ?? item.updatedAt;
            const last = item.timelineEnd ?? item.updatedAt;
            const itemCommits = projectCommits.length;
            const itemSessions = projectSessions.length;
            const quest = attribution.get(String(item.id))?.questTitle;
            const impact = impacts.get(
              formatEvidenceRef({ kind: "monday", itemId: String(item.id) }),
            );
            const base = impact
              ? `${impact.theme ? `[${impact.theme}] ` : ""}${impact.text}`
              : item.name;
            const name = quest ? `${base} — ${quest}` : base;
            return [
              name,
              localDateTime(first, range.timeZone),
              localDateTime(last, range.timeZone),
              elapsedLabel(first, last),
              String(itemCommits),
              String(itemSessions),
            ];
          })
        : branchRows(
            projectCommits,
            projectSessions,
            queryPullRequestsByRepo(database, key.org, key.project),
            range.timeZone,
            attribution,
            impacts,
          )
    ).map((row) => [...row, "-", "-"]);

    const rows = [...questRows, ...otherRows];

    const sideQuestMinutes = projectSideQuests.reduce((sum, quest) => sum + quest.minutes, 0);
    const mainStintMinutes = stints
      .filter((stint) => stint.org === key.org && stint.project === key.project)
      .reduce((sum, stint) => sum + stint.minutes, 0);
    const totalMinutes = sideQuestMinutes + mainStintMinutes;
    const percent = totalMinutes > 0 ? Math.round((sideQuestMinutes / totalMinutes) * 100) : 0;
    const sideQuestFooter =
      projectSideQuests.length > 0
        ? [
            `side quests: ${projectSideQuests.length}, ${minutesLabel(sideQuestMinutes)} (${percent}% of project time)`,
          ]
        : [];

    const lines =
      rows.length > 0
        ? [
            heading(3, projectLabel(key, projectSessions)),
            "Elapsed is an upper bound.",
            "",
            table(
              [
                "quest",
                "first evidence",
                "last evidence",
                "elapsed (upper bound)",
                "commits",
                "sessions",
                "stints",
                "side-quest minutes",
              ],
              rows,
            ),
            ...sideQuestFooter,
          ]
        : [heading(3, projectLabel(key, projectSessions)), "- no evidence"];
    sections.push(lines.join("\n"));
  }

  if (sections.length === 1) sections.push("no evidence");

  return sections.join("\n\n");
}

const PULL_REF_PATTERN = /^pull\/(\d+)\/head$/;

function branchLabel(branch: string, pullRequestsByNumber: Map<number, PullRequestRow>): string {
  const match = branch.match(PULL_REF_PATTERN);
  if (!match) return branch;

  const number = Number.parseInt(match[1] as string, 10);
  const pullRequest = pullRequestsByNumber.get(number);
  return pullRequest ? `PR #${number} ${pullRequest.title}` : `PR #${number}`;
}

function branchRows(
  commits: CommitRow[],
  sessions: SessionRow[],
  pullRequests: PullRequestRow[],
  timeZone: string,
  attribution: Map<string, NonClaudeEvidenceRow>,
  impacts: Map<string, ImpactRow>,
): string[][] {
  const pullRequestsByNumber = new Map(pullRequests.map((pr) => [pr.number, pr]));

  const byBranch = new Map<string, CommitRow[]>();
  for (const commit of commits) {
    const branch = inferBranch(commit.branches);
    const list = byBranch.get(branch) ?? [];
    list.push(commit);
    byBranch.set(branch, list);
  }

  const branches = [...byBranch.keys()].sort();
  return branches.map((branch) => {
    const branchCommits = (byBranch.get(branch) ?? []).sort((a, b) =>
      a.authoredAt.localeCompare(b.authoredAt),
    );
    const branchSessions = sessions.filter((session) => session.gitBranch === branch);
    const first = branchCommits[0]?.authoredAt ?? "";
    const last = branchCommits[branchCommits.length - 1]?.authoredAt ?? "";
    const quest = branchCommits
      .map((commit) => attribution.get(commit.sha)?.questTitle)
      .find((title): title is string => Boolean(title));
    const impact = branchCommits
      .map((commit) => impacts.get(formatEvidenceRef({ kind: "commit", sha: commit.sha })))
      .find((row): row is ImpactRow => row !== undefined);
    const label = impact
      ? `${impact.theme ? `[${impact.theme}] ` : ""}${impact.text}`
      : branchLabel(branch, pullRequestsByNumber);
    return [
      quest ? `${label} — ${quest}` : label,
      localDateTime(first, timeZone),
      localDateTime(last, timeZone),
      elapsedLabel(first, last),
      String(branchCommits.length),
      String(branchSessions.length),
    ];
  });
}

export const projectReport: Report = {
  kind: "project",
  render,
};
