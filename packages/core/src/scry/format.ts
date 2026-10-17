import type { Check, CheckStatus, Recommendation, ScryReport, ScryStats } from "./types";

const MARK: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" };

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatAge(hours: number | null): string {
  if (hours === null) return "never";
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))} min ago`;
  if (hours < 48) return `${hours.toFixed(1)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function shortTimestamp(value: string | null): string {
  return value === null ? "none" : value.slice(0, 16).replace("T", " ");
}

function counts(record: Record<string, number>): string {
  const entries = Object.entries(record).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "none" : entries.map(([key, n]) => `${key} ${n}`).join(", ");
}

function checkLines(entry: Check): string[] {
  const lines = [`  ${MARK[entry.status]}  ${entry.title.padEnd(24)} ${entry.summary}`];
  for (const detail of entry.details) lines.push(`        ${detail}`);
  return lines;
}

function statsLines(stats: ScryStats): string[] {
  const { database, sources, collectors, quests, stints, traces, questions, w5, sync } = stats;
  const lines = [
    `  database       ${formatBytes(database.sizeBytes)}, schema ${database.schemaVersion}, ${stats.events} events`,
    `  claude         ${sources.claudeSessions.rows} sessions (newest ${shortTimestamp(sources.claudeSessions.newest)}), ${sources.claudeMessages.rows} messages (newest ${shortTimestamp(sources.claudeMessages.newest)})`,
    `  github         ${sources.githubCommits.rows} commits (newest ${shortTimestamp(sources.githubCommits.newest)}), ${sources.githubPullRequests.rows} pull requests`,
    `  monday         ${sources.mondayItems.rows} items (newest update ${shortTimestamp(sources.mondayItems.newest)})`,
    `  collectors     ${collectors.map((collector) => `${collector.source} ${formatAge(collector.ageHours)}`).join(", ")}`,
  ];
  lines.push(
    `  quests         ${counts(quests.byState)}${quests.unconfirmed > 0 ? ` (${quests.unconfirmed} unconfirmed)` : ""}`,
    `  stints         ${stints.open} open, ${stints.closed} closed, ${stints.dismissed} dismissed`,
    `  questions      ${counts(questions.byState)}`,
  );
  if (w5) {
    lines.push(
      `  last ${w5.windowDays} days    ${w5.sessionsInWindow} sessions${w5.ownHostOnly ? " on this host" : ""} (${w5.sessionsDeclared} declared a quest, ${w5.sessionsUndeclared} did not), ${w5.sessionsWithTraces} with traces; ${traces.inWindow} traces, ${stints.withoutQuestInWindow} stints without a quest`,
      `  windows        ${w5.windowsCovered} classified, ${w5.windowsPending} not${w5.windowsInFlight > 0 ? `, ${w5.windowsInFlight} in flight` : ""}`,
      `  jobs           queued ${w5.jobs.queued}, running ${w5.jobs.running}, done ${w5.jobs.done}, failed ${w5.jobs.failed} (${w5.jobsFailedLast7Days} in the last 7 days)`,
    );
  }
  if (sync) {
    lines.push(
      `  sync           ${sync.enabled ? "enabled" : "not configured"}, ${sync.dirty.events} events + ${sync.dirty.mirrors} rows + ${sync.dirty.tombstones} tombstones unpushed${sync.forgottenServers > 0 ? `, ${sync.forgottenServers} forgotten server(s)` : ""}`,
    );
  }
  return lines;
}

function recommendationLines(recommendations: Recommendation[]): string[] {
  if (recommendations.length === 0) return ["  nothing to do"];
  const lines: string[] = [];
  for (const [index, entry] of recommendations.entries()) {
    lines.push(`  ${index + 1}. ${entry.command}`);
    lines.push(`     ${entry.reason}`);
    if (entry.condition) lines.push(`     ${entry.condition}`);
  }
  return lines;
}

/** The human-readable report: Health, Stats, Recommendations, then notes. */
export function formatReport(report: ScryReport): string {
  const lines: string[] = [
    `tempad scry  ${report.generatedAt.slice(0, 16).replace("T", " ")} UTC  ${report.home}  window ${report.windowDays} days`,
    "",
    `Health: ${report.ok ? "healthy" : "NOT healthy"}`,
  ];
  for (const entry of report.checks) lines.push(...checkLines(entry));
  if (report.stats) {
    lines.push("", "Stats", ...statsLines(report.stats));
  }
  lines.push("", "Recommendations", ...recommendationLines(report.recommendations));
  if (report.notes.length > 0) {
    lines.push("", "Notes");
    for (const note of report.notes) lines.push(`  ${note}`);
  }
  lines.push("", `${report.durationMs} ms`);
  return lines.join("\n");
}
