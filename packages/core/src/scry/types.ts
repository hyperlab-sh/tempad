/** `skip` means the check did not run (`--fast`, or a precondition failed); it never fails the command. */
export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  /** Extra lines under the summary: which table differs, the top error, and so on. */
  details: string[];
}

/** One thing worth running. `condition` marks it as "only if"; without it, the data says run it now. */
export interface Recommendation {
  id: string;
  command: string;
  reason: string;
  condition?: string;
}

export interface SourceStats {
  rows: number;
  /** Newest row's own timestamp (commit date, message time, ...); null when the table is empty. */
  newest: string | null;
}

export interface CollectorStats {
  source: string;
  lastSyncAt: string | null;
  ageHours: number | null;
}

export interface SyncStats {
  /** `[sync]` is present and enabled. */
  enabled: boolean;
  /** The mirror triggers are installed (`mirror_sync_enabled`): sync has been on at some point. */
  mirrorTriggers: boolean;
  serverKnown: boolean;
  dirty: { events: number; mirrors: number; tombstones: number };
  /** Stamp of the last row this host pushed (the push probe); the database records no pull time. */
  lastPushedStamp: string | null;
  pending: { reseed: boolean; pullOwn: boolean; rebuild: boolean };
  forgottenServers: number;
}

export interface W5Stats {
  windowDays: number;
  ownHostOnly: boolean;
  sessionsInWindow: number;
  sessionsWithTraces: number;
  sessionsDeclared: number;
  sessionsUndeclared: number;
  windowsCovered: number;
  windowsPending: number;
  /** Pending windows that ended within the last hour: a live session the hook has not reached yet. */
  windowsInFlight: number;
  pendingSessions: number;
  oldestPendingSessionEndedAt: string | null;
  jobs: { queued: number; running: number; done: number; failed: number };
  jobsFailedLast7Days: number;
  jobsStuckRunning: number;
}

export interface IntentStats {
  events: number;
  quests: Record<string, number>;
  questsUnconfirmed: number;
  stints: { open: number; closed: number; dismissed: number };
  stintsWithoutQuestInWindow: number;
  tracesInWindow: number;
  doubtedTracesLast7Days: number;
  questions: Record<string, number>;
  questionsExpiredUnanswered: number;
}

export interface ScryStats {
  database: { path: string; sizeBytes: number; schemaVersion: number; latestSchemaVersion: number };
  sources: {
    claudeSessions: SourceStats;
    claudeMessages: SourceStats;
    githubCommits: SourceStats;
    githubPullRequests: SourceStats;
    mondayItems: SourceStats;
  };
  collectors: CollectorStats[];
  intent: IntentStats | null;
  w5: W5Stats | null;
  sync: SyncStats | null;
}

export interface ScryReport {
  generatedAt: string;
  home: string;
  /** False when any check failed; warnings and recommendations leave it true. */
  ok: boolean;
  windowDays: number;
  checks: Check[];
  stats: ScryStats | null;
  recommendations: Recommendation[];
  /** Why something was not recommended, when the data speaks to it. */
  notes: string[];
  durationMs: number;
}
