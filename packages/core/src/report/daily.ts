import type { Database } from "bun:sqlite";
import type { LoadedConfig } from "../config/env.ts";
import { queryImpacts } from "../intent/api.ts";
import { formatEvidenceRef } from "../intent/evidence-ref.ts";
import { projectLabel } from "./format.ts";
import {
  attributeNonClaudeEvidence,
  queryDismissedMinutesByQuest,
  queryOpenQuestions,
  querySideQuests,
  queryStints,
  resolveIntentDatabase,
  type SideQuestRow,
  type StintRow,
} from "./intent-queries.ts";
import { dayRange, heading, isWeekend, localDay, localTime, localWeekday } from "./markdown.ts";
import {
  type CommitRow,
  groupDuplicateCommits,
  isNamedTitleSource,
  type MondayItemRow,
  type PullRequestRow,
  queryCommits,
  queryMondayItems,
  queryPullRequests,
  querySessions,
  type SessionRow,
} from "./queries.ts";
import type { Report, ReportOptions } from "./types.ts";

interface ProjectKey {
  org: string;
  project: string;
}

function projectKeyString(key: ProjectKey): string {
  return `${key.org}/${key.project}`;
}

function render(database: Database, config: LoadedConfig<"tz">, options: ReportOptions): string {
  const timeZone = config.tz;
  const prDate = options.prDate ?? "merged";
  const range = {
    from: options.from,
    to: options.to,
    timeZone,
    org: options.org,
    project: options.project,
    client: options.client,
  };
  const intentDatabase = resolveIntentDatabase(database, options.asOf);

  const commits = queryCommits(database, range);
  const sessions = querySessions(database, range);
  const mondayItems = queryMondayItems(database, range);
  const pullRequests = queryPullRequests(database, range);

  const days = dayRange(options.from, options.to);
  const titleSuffix = options.asOf ? ` (as of ${options.asOf})` : "";
  const sections: string[] = [
    heading(1, `daily report ${options.from} to ${options.to}${titleSuffix}`),
  ];

  for (const day of days) {
    const dayCommits = commits.filter((row) => localDay(row.authoredAt, timeZone) === day);
    const daySessions = sessions.filter((row) => sessionTouchesDay(row, day, timeZone));
    const dayMondayItems = mondayItems.filter((row) => mondayTouchesDay(row, day, timeZone));
    const dayPullRequests = pullRequests.filter((row) =>
      pullRequestTouchesDay(row, day, timeZone, prDate),
    );
    const dayRangeOptions = {
      from: day,
      to: day,
      timeZone,
      org: options.org,
      project: options.project,
      client: options.client,
    };
    const dayStints = queryStints(intentDatabase, dayRangeOptions);
    const daySideQuests = querySideQuests(intentDatabase, dayRangeOptions);
    const dayDismissedMinutes = queryDismissedMinutesByQuest(intentDatabase, dayRangeOptions);
    const dayAttribution = new Map(
      attributeNonClaudeEvidence(intentDatabase, dayRangeOptions).map((row) => [row.id, row]),
    );
    const dayImpactSubjects = [
      ...dayCommits.map((row) => formatEvidenceRef({ kind: "commit", sha: row.sha })),
      ...dayPullRequests.map((row) =>
        formatEvidenceRef({ kind: "pr", repo: row.repo, number: row.number }),
      ),
      ...dayMondayItems.map((row) => formatEvidenceRef({ kind: "monday", itemId: String(row.id) })),
      ...daySessions.map((row) => formatEvidenceRef({ kind: "session", sessionId: row.id })),
    ];
    const dayImpacts = queryImpacts(intentDatabase, dayImpactSubjects);

    const hasEvidence =
      dayCommits.length > 0 ||
      daySessions.length > 0 ||
      dayMondayItems.length > 0 ||
      dayPullRequests.length > 0 ||
      dayStints.length > 0 ||
      daySideQuests.length > 0;

    if (!hasEvidence && isWeekend(day, timeZone)) continue;

    const weekday = localWeekday(day, timeZone);
    const lines: string[] = [heading(2, `${day} (${weekday})`)];

    if (!hasEvidence) {
      lines.push("- no evidence");
      sections.push(lines.join("\n"));
      continue;
    }

    const projectKeys = collectProjectKeys(
      dayCommits,
      daySessions,
      dayMondayItems,
      dayPullRequests,
      dayStints,
      daySideQuests,
    );

    for (const key of projectKeys) {
      lines.push(heading(3, projectLabel(key, daySessions)));

      const keyCommits = dayCommits.filter((row) => matchesKey(row, key));
      for (const group of groupDuplicateCommits(keyCommits)) {
        const suffix = group.count > 1 ? ` (x${group.count})` : "";
        const quest = dayAttribution.get(group.sha)?.questTitle;
        const attribution = quest ? ` — ${quest}` : "";
        const impact = dayImpacts.get(formatEvidenceRef({ kind: "commit", sha: group.sha }));
        const text = impact
          ? `${impact.theme ? `[${impact.theme}] ` : ""}${impact.text}`
          : group.subject;
        lines.push(`- ${group.sha.slice(0, 7)} ${text} (${group.repo})${suffix}${attribution}`);
      }

      const keySessions = daySessions.filter((row) => matchesKey(row, key));
      const sessionImpacts = new Map(
        keySessions.map((session) => [
          session.id,
          dayImpacts.get(formatEvidenceRef({ kind: "session", sessionId: session.id })),
        ]),
      );
      const namedSessions = keySessions.filter(
        (row) => isNamedTitleSource(row.titleSource) || sessionImpacts.get(row.id) !== undefined,
      );
      const untitledSessions = keySessions.filter(
        (row) => !isNamedTitleSource(row.titleSource) && sessionImpacts.get(row.id) === undefined,
      );

      for (const session of namedSessions) {
        const startTime = localTime(session.startedAt, timeZone);
        const endTime = localTime(session.endedAt, timeZone);
        const impact = sessionImpacts.get(session.id);
        const text = impact
          ? `${impact.theme ? `[${impact.theme}] ` : ""}${impact.text}`
          : (session.title ?? "(untitled session)");
        lines.push(`- ${text}, ${startTime} to ${endTime}, ${session.messageCount} messages`);
      }
      if (untitledSessions.length > 0) {
        const totalMessages = untitledSessions.reduce(
          (sum, session) => sum + session.messageCount,
          0,
        );
        lines.push(`- ${untitledSessions.length} untitled sessions (${totalMessages} messages)`);
      }
      for (const item of dayMondayItems.filter((row) => matchesKey(row, key))) {
        const timeline =
          item.timelineStart && item.timelineEnd
            ? `${item.timelineStart} to ${item.timelineEnd}`
            : "no timeline";
        const quest = dayAttribution.get(String(item.id))?.questTitle;
        const attribution = quest ? ` — ${quest}` : "";
        const impact = dayImpacts.get(
          formatEvidenceRef({ kind: "monday", itemId: String(item.id) }),
        );
        const text = impact
          ? `${impact.theme ? `[${impact.theme}] ` : ""}${impact.text}`
          : item.name;
        lines.push(`- [${item.status ?? "no status"}] ${text}, timeline ${timeline}${attribution}`);
      }
      for (const pr of dayPullRequests.filter((row) => matchesKey(row, key))) {
        const action = prAction(pr, day, timeZone);
        const impact = dayImpacts.get(
          formatEvidenceRef({ kind: "pr", repo: pr.repo, number: pr.number }),
        );
        const text = impact
          ? `${impact.theme ? `[${impact.theme}] ` : ""}${impact.text}`
          : pr.title;
        lines.push(`- #${pr.number} ${text}, ${action}`);
      }

      const keyStints = dayStints.filter((row) => matchesKey(row, key));
      const keyDismissedMinutes = dayDismissedMinutes.filter((row) => matchesKey(row, key));
      if (keyStints.length > 0) {
        lines.push(heading(4, "Quests"));
        for (const [questTitle, questStints] of groupByQuest(keyStints)) {
          const unconfirmed = questStints[0]?.questConfirmed === false ? " [unconfirmed]" : "";
          const inferred =
            questStints[0]?.questOriginKind && questStints[0].questOriginKind !== "declared"
              ? " (inferred)"
              : "";
          const outcomes = questStints.map((stint) => stint.outcome).join("; ");
          const minutes = questStints.reduce((sum, stint) => sum + stint.minutes, 0);
          lines.push(
            `- ${questTitle}${unconfirmed}${inferred}: ${outcomes} (${minutesLabel(minutes)})`,
          );
          const groupQuestIds = new Set(questStints.map((stint) => stint.questId));
          const shortWorkMinutes = keyDismissedMinutes
            .filter((row) => groupQuestIds.has(row.questId))
            .reduce((sum, row) => sum + row.minutes, 0);
          if (shortWorkMinutes > 0) {
            lines.push(`  - short work: ${Math.round(shortWorkMinutes)} min`);
          }
        }
      }

      const keySideQuests = daySideQuests.filter((row) => matchesKey(row, key));
      if (keySideQuests.length > 0) {
        lines.push(heading(4, "Side quests"));
        for (const sideQuest of keySideQuests) {
          const branchTime = localTime(sideQuest.branchedAt, timeZone);
          const returned = sideQuest.returnedAt
            ? `back ${localTime(sideQuest.returnedAt, timeZone)}`
            : "not returned";
          lines.push(
            `- ${sideQuest.title}, branched ${branchTime} from "${sideQuest.fromStintOutcome ?? sideQuest.fromQuestTitle ?? "unknown"}", trigger: "${sideQuest.trigger ?? "unknown"}", ${returned} (${minutesLabel(sideQuest.minutes)})`,
          );
        }
      }

      const tracesAwaitingReview = queryOpenQuestions(intentDatabase, {
        ...dayRangeOptions,
        org: key.org,
        project: key.project,
      });
      if (tracesAwaitingReview > 0) {
        lines.push(`- ${tracesAwaitingReview} traces awaiting review`);
      }
    }

    sections.push(lines.join("\n"));
  }

  if (sections.length === 1) sections.push("no evidence");

  return sections.join("\n\n");
}

function sessionTouchesDay(session: SessionRow, day: string, timeZone: string): boolean {
  return (
    localDay(session.startedAt, timeZone) === day || localDay(session.endedAt, timeZone) === day
  );
}

function mondayTouchesDay(item: MondayItemRow, day: string, timeZone: string): boolean {
  if (item.timelineStart && item.timelineEnd) {
    if (item.timelineStart <= day && item.timelineEnd >= day) return true;
  }
  return localDay(item.updatedAt, timeZone) === day;
}

function pullRequestTouchesDay(
  pr: PullRequestRow,
  day: string,
  timeZone: string,
  prDate: "merged" | "authored",
): boolean {
  if (prDate === "authored") {
    const placedAt = pr.firstAuthoredAt ?? pr.createdAt;
    return localDay(placedAt, timeZone) === day;
  }
  if (localDay(pr.createdAt, timeZone) === day) return true;
  if (pr.mergedAt && localDay(pr.mergedAt, timeZone) === day) return true;
  if (pr.closedAt && localDay(pr.closedAt, timeZone) === day) return true;
  return false;
}

function prAction(pr: PullRequestRow, day: string, timeZone: string): string {
  if (pr.mergedAt && localDay(pr.mergedAt, timeZone) === day) return "merged";
  if (pr.closedAt && localDay(pr.closedAt, timeZone) === day) return "closed";
  if (localDay(pr.createdAt, timeZone) === day) return "opened";
  return pr.state;
}

function matchesKey(row: { org: string | null; project: string | null }, key: ProjectKey): boolean {
  return row.org === key.org && row.project === key.project;
}

function collectProjectKeys(
  commits: CommitRow[],
  sessions: SessionRow[],
  mondayItems: MondayItemRow[],
  pullRequests: PullRequestRow[],
  stints: StintRow[],
  sideQuests: SideQuestRow[],
): ProjectKey[] {
  const keys = new Map<string, ProjectKey>();
  for (const row of [...commits, ...sessions, ...mondayItems, ...pullRequests]) {
    const key = { org: row.org, project: row.project };
    keys.set(projectKeyString(key), key);
  }
  for (const row of [...stints, ...sideQuests]) {
    if (!row.org || !row.project) continue;
    const key = { org: row.org, project: row.project };
    keys.set(projectKeyString(key), key);
  }
  return [...keys.values()].sort((a, b) => projectKeyString(a).localeCompare(projectKeyString(b)));
}

function minutesLabel(totalMinutes: number): string {
  const rounded = Math.round(totalMinutes);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return `${hours}h ${minutes}m`;
}

/** Stints grouped by their quest title, in first-seen order. */
function groupByQuest(stints: StintRow[]): [string, StintRow[]][] {
  const groups = new Map<string, StintRow[]>();
  for (const stint of stints) {
    const title = stint.questTitle ?? "(no quest)";
    const list = groups.get(title) ?? [];
    list.push(stint);
    groups.set(title, list);
  }
  return [...groups.entries()];
}

export const dailyReport: Report = {
  kind: "daily",
  render,
};
