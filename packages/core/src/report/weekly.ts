import type { Database } from "bun:sqlite";
import type { LoadedConfig } from "../config/env.ts";
import { projectLabel } from "./format.ts";
import {
  queryDismissedMinutesByQuest,
  queryDoubtRows,
  queryQuests,
  querySideQuests,
  queryStints,
  resolveIntentDatabase,
} from "./intent-queries.ts";
import { dayRange, heading, isWeekend, localWeekday, table } from "./markdown.ts";
import { querySessions } from "./queries.ts";
import type { Report, ReportOptions } from "./types.ts";

interface ProjectKey {
  org: string;
  project: string;
}

function projectKeyString(key: ProjectKey): string {
  return `${key.org}/${key.project}`;
}

function minutesLabel(totalMinutes: number): string {
  const rounded = Math.round(totalMinutes);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return `${hours}h ${minutes}m`;
}

interface DayProjectStats {
  stints: number;
  questsTouched: number;
  shipped: number;
  abandoned: number;
  sideQuests: number;
  sideQuestMinutes: number;
  unconfirmedQuests: number;
  doubts: number;
  shortWorkMinutes: number;
}

function emptyStats(): DayProjectStats {
  return {
    stints: 0,
    questsTouched: 0,
    shipped: 0,
    abandoned: 0,
    sideQuests: 0,
    sideQuestMinutes: 0,
    unconfirmedQuests: 0,
    doubts: 0,
    shortWorkMinutes: 0,
  };
}

function addStats(a: DayProjectStats, b: DayProjectStats): DayProjectStats {
  return {
    stints: a.stints + b.stints,
    questsTouched: a.questsTouched + b.questsTouched,
    shipped: a.shipped + b.shipped,
    abandoned: a.abandoned + b.abandoned,
    sideQuests: a.sideQuests + b.sideQuests,
    sideQuestMinutes: a.sideQuestMinutes + b.sideQuestMinutes,
    unconfirmedQuests: a.unconfirmedQuests + b.unconfirmedQuests,
    doubts: a.doubts + b.doubts,
    shortWorkMinutes: a.shortWorkMinutes + b.shortWorkMinutes,
  };
}

function statsRow(label: string, stats: DayProjectStats): string[] {
  return [
    label,
    String(stats.stints),
    String(stats.questsTouched),
    String(stats.shipped),
    String(stats.abandoned),
    String(stats.sideQuests),
    minutesLabel(stats.sideQuestMinutes),
    String(stats.unconfirmedQuests),
    String(stats.doubts),
    minutesLabel(stats.shortWorkMinutes),
  ];
}

const HEADERS = [
  "project",
  "stints",
  "quests touched",
  "shipped",
  "abandoned",
  "side quests",
  "side-quest minutes",
  "unconfirmed quests",
  "doubts",
  "short work",
];

function render(database: Database, config: LoadedConfig<"tz">, options: ReportOptions): string {
  const timeZone = config.tz;
  const days = dayRange(options.from, options.to);
  const intentDatabase = resolveIntentDatabase(database, options.asOf);
  const titleSuffix = options.asOf ? ` (as of ${options.asOf})` : "";
  const sections: string[] = [
    heading(1, `weekly report ${options.from} to ${options.to}${titleSuffix}`),
  ];

  const weekTotals = new Map<string, { key: ProjectKey; stats: DayProjectStats }>();
  const allSessions = querySessions(database, {
    from: options.from,
    to: options.to,
    timeZone,
    org: options.org,
    project: options.project,
    client: options.client,
  });

  for (const day of days) {
    const dayRangeOptions = {
      from: day,
      to: day,
      timeZone,
      org: options.org,
      project: options.project,
      client: options.client,
    };
    const daySessions = querySessions(database, dayRangeOptions);
    const stints = queryStints(intentDatabase, dayRangeOptions);
    const quests = queryQuests(intentDatabase, dayRangeOptions);
    const sideQuests = querySideQuests(intentDatabase, dayRangeOptions);
    const doubtRows = queryDoubtRows(intentDatabase, dayRangeOptions);
    const dismissedMinutes = queryDismissedMinutesByQuest(intentDatabase, dayRangeOptions);

    const hasEvidence = stints.length > 0 || quests.length > 0 || sideQuests.length > 0;
    if (!hasEvidence && isWeekend(day, timeZone)) continue;

    const keys = new Map<string, ProjectKey>();
    for (const row of [...stints, ...quests, ...sideQuests]) {
      if (!row.org || !row.project) continue;
      keys.set(projectKeyString({ org: row.org, project: row.project }), {
        org: row.org,
        project: row.project,
      });
    }

    const weekday = localWeekday(day, timeZone);
    const lines = [heading(2, `${day} (${weekday})`)];

    if (keys.size === 0) {
      lines.push("no evidence");
      sections.push(lines.join("\n"));
      continue;
    }

    const sortedKeys = [...keys.values()].sort((a, b) =>
      projectKeyString(a).localeCompare(projectKeyString(b)),
    );

    const rows: string[][] = [];
    let dayTotal = emptyStats();

    for (const key of sortedKeys) {
      const stats: DayProjectStats = {
        stints: stints.filter((row) => row.org === key.org && row.project === key.project).length,
        questsTouched: quests.filter((row) => row.org === key.org && row.project === key.project)
          .length,
        shipped: quests.filter(
          (row) => row.org === key.org && row.project === key.project && row.state === "done",
        ).length,
        abandoned: quests.filter(
          (row) => row.org === key.org && row.project === key.project && row.state === "abandoned",
        ).length,
        sideQuests: sideQuests.filter((row) => row.org === key.org && row.project === key.project)
          .length,
        sideQuestMinutes: sideQuests
          .filter((row) => row.org === key.org && row.project === key.project)
          .reduce((sum, row) => sum + row.minutes, 0),
        unconfirmedQuests: quests.filter(
          (row) => row.org === key.org && row.project === key.project && !row.confirmed,
        ).length,
        doubts: doubtRows.filter((row) => row.org === key.org && row.project === key.project)
          .length,
        shortWorkMinutes: dismissedMinutes
          .filter((row) => row.org === key.org && row.project === key.project)
          .reduce((sum, row) => sum + row.minutes, 0),
      };

      rows.push(statsRow(projectLabel(key, daySessions), stats));
      dayTotal = addStats(dayTotal, stats);

      const existing = weekTotals.get(projectKeyString(key));
      weekTotals.set(projectKeyString(key), {
        key,
        stats: addStats(existing?.stats ?? emptyStats(), stats),
      });
    }

    rows.push(statsRow("Totals", dayTotal));

    lines.push("", table(HEADERS, rows));
    sections.push(lines.join("\n"));
  }

  if (weekTotals.size > 0) {
    const sortedWeekKeys = [...weekTotals.values()].sort((a, b) =>
      projectKeyString(a.key).localeCompare(projectKeyString(b.key)),
    );
    const rows = sortedWeekKeys.map(({ key, stats }) =>
      statsRow(projectLabel(key, allSessions), stats),
    );
    const weekTotal = sortedWeekKeys.reduce((sum, { stats }) => addStats(sum, stats), emptyStats());
    rows.push(statsRow("Totals", weekTotal));

    sections.push([heading(2, "Week"), "", table(HEADERS, rows)].join("\n"));
  }

  return sections.join("\n\n");
}

export const weeklyReport: Report = {
  kind: "weekly",
  render,
};
