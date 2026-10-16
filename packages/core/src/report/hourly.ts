import type { Database } from "bun:sqlite";
import type { LoadedConfig } from "../config/env.ts";
import {
  querySideQuests,
  queryStintTraceIntervals,
  resolveIntentDatabase,
  type StintTraceIntervalRow,
} from "./intent-queries.ts";
import {
  dayRange,
  heading,
  localDay,
  localHour,
  table,
  utcInstantForLocalMidnight,
} from "./markdown.ts";
import {
  groupDuplicateCommits,
  isNamedTitleSource,
  queryCommits,
  querySessionMessagesByHour,
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
  const messages = querySessionMessagesByHour(database, range);

  const days = dayRange(options.from, options.to);
  const titleSuffix = options.asOf ? ` (as of ${options.asOf})` : "";
  const sections: string[] = [
    heading(1, `hourly report ${options.from} to ${options.to}${titleSuffix}`),
  ];

  for (const day of days) {
    const dayCommits = commits.filter((row) => localDay(row.authoredAt, timeZone) === day);
    const dayMessages = messages.filter((row) => localDay(row.ts, timeZone) === day);
    const dayRangeOptions = {
      from: day,
      to: day,
      timeZone,
      org: options.org,
      project: options.project,
      client: options.client,
    };
    const daySideQuests = querySideQuests(intentDatabase, dayRangeOptions);
    const dayStintIntervals = queryStintTraceIntervals(intentDatabase, dayRangeOptions);

    const keys = new Map<string, ProjectKey>();
    for (const row of [...dayCommits, ...dayMessages]) {
      keys.set(projectKeyString({ org: row.org, project: row.project }), {
        org: row.org,
        project: row.project,
      });
    }
    for (const sideQuest of daySideQuests) {
      if (!sideQuest.org || !sideQuest.project) continue;
      keys.set(projectKeyString({ org: sideQuest.org, project: sideQuest.project }), {
        org: sideQuest.org,
        project: sideQuest.project,
      });
    }
    for (const interval of dayStintIntervals) {
      if (!interval.org || !interval.project) continue;
      keys.set(projectKeyString({ org: interval.org, project: interval.project }), {
        org: interval.org,
        project: interval.project,
      });
    }
    const projectKeys = [...keys.values()].sort((a, b) =>
      projectKeyString(a).localeCompare(projectKeyString(b)),
    );

    const lines = [heading(2, day)];

    if (projectKeys.length === 0) {
      lines.push("no evidence");
      sections.push(lines.join("\n"));
      continue;
    }

    const headers = ["hour", ...projectKeys.map(projectKeyString)];
    const rows: string[][] = [];

    for (let hour = 0; hour < 24; hour++) {
      const label = `${String(hour).padStart(2, "0")}:00`;
      const row = [label];

      for (const key of projectKeys) {
        const cellCommits = dayCommits.filter(
          (row) =>
            row.org === key.org &&
            row.project === key.project &&
            localHour(row.authoredAt, timeZone) === hour,
        );

        const hourMessages = dayMessages.filter(
          (row) =>
            row.org === key.org &&
            row.project === key.project &&
            localHour(row.ts, timeZone) === hour,
        );

        const bySession = new Map<
          string,
          { title: string | null; titleSource: string | null; count: number }
        >();
        for (const message of hourMessages) {
          const existing = bySession.get(message.sessionId);
          if (existing) {
            existing.count += 1;
          } else {
            bySession.set(message.sessionId, {
              title: message.title,
              titleSource: message.titleSource,
              count: 1,
            });
          }
        }

        const parts: string[] = [];
        let untitledCount = 0;
        let untitledMessages = 0;
        for (const session of bySession.values()) {
          if (isNamedTitleSource(session.titleSource)) {
            parts.push(`${session.title ?? "(untitled session)"} (${session.count} messages)`);
          } else {
            untitledCount += 1;
            untitledMessages += session.count;
          }
        }
        if (untitledCount > 0) {
          parts.push(`+${untitledCount} untitled (${untitledMessages} messages)`);
        }
        for (const group of groupDuplicateCommits(cellCommits)) {
          const suffix = group.count > 1 ? ` (x${group.count})` : "";
          parts.push(`${group.sha.slice(0, 7)}${suffix}`);
        }

        const hourIntervals = dayStintIntervals.filter(
          (interval) => interval.org === key.org && interval.project === key.project,
        );
        for (const [label, minutes] of hourStintMinutes(hourIntervals, timeZone, day, hour)) {
          parts.push(`${label} (${minutesLabel(minutes)})`);
        }

        for (const sideQuest of daySideQuests) {
          if (
            sideQuest.org === key.org &&
            sideQuest.project === key.project &&
            localHour(sideQuest.branchedAt, timeZone) === hour
          ) {
            parts.push(`↳ ${sideQuest.title}`);
          }
        }

        row.push(parts.join("; "));
      }

      rows.push(row);
    }

    lines.push("", table(headers, rows));
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

function minutesLabel(totalMinutes: number): string {
  const rounded = Math.round(totalMinutes);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Minutes of trace-backed stint time within [hour:00, hour+1:00) local
 * time on `day`, grouped by quest title (or the stint's own outcome
 * when it has no quest), for the hourly report's per-hour stint list.
 */
function hourStintMinutes(
  intervals: StintTraceIntervalRow[],
  timeZone: string,
  day: string,
  hour: number,
): [string, number][] {
  const dayStartMs = new Date(utcInstantForLocalMidnight(day, timeZone)).getTime();
  const hourStartMs = dayStartMs + hour * 3600_000;
  const hourEndMs = hourStartMs + 3600_000;

  const minutesByLabel = new Map<string, number>();
  for (const interval of intervals) {
    const intervalStart = Math.max(new Date(interval.startedAt).getTime(), hourStartMs);
    const intervalEnd = Math.min(new Date(interval.endedAt).getTime(), hourEndMs);
    if (intervalEnd <= intervalStart) continue;
    const label = interval.questTitle ?? interval.outcome;
    const minutes = (intervalEnd - intervalStart) / 60000;
    minutesByLabel.set(label, (minutesByLabel.get(label) ?? 0) + minutes);
  }

  return [...minutesByLabel.entries()];
}

export const hourlyReport: Report = {
  kind: "hourly",
  render,
};
