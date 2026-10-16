import type { Database } from "bun:sqlite";
import { loadMigrations } from "../db/migration-files";
import type { W5Config } from "../intent/config";
import { hasAnyDeclaration, sessionEverDeclared } from "../intent/declarations";
import { listProjections } from "../intent/projections";
import {
  FORGOTTEN_SERVER_PREFIX,
  PULL_OWN_PENDING,
  PUSH_PROBE_ROW,
  REBUILD_PENDING,
  RESEED_PENDING,
  SERVER_ID,
} from "../sync/engine";
import { SYNCED_UPSERT_TABLES } from "../sync/tables";
import { MIRROR_SYNC_ENABLED } from "../sync/triggers";
import { planBackfillWindows, selectBackfillSessions } from "../w5/backfill";
import { compareProjectionsToReplay } from "./replay";
import type {
  Check,
  CheckStatus,
  CollectorStats,
  IntentStats,
  Recommendation,
  ScryReport,
  ScryStats,
  SourceStats,
  SyncStats,
  W5Stats,
} from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A collector that has not run for this long is called stale. */
export const COLLECTOR_STALE_HOURS = 24;
/** A claimed job still running after this long is called stuck. */
const STUCK_JOB_HOURS = 1;
/** A window that ended this recently belongs to a session the hook is still working on. */
const IN_FLIGHT_MS = HOUR_MS;
/** An eval only says something against a baseline this big. */
export const EVAL_MIN_SESSIONS = 5;
const EVAL_WINDOW_DAYS = 7;
const SOURCES = ["monday", "github", "claude"] as const;

/** Order of the recommendations: repair the data, collect, classify, sync, then what waits for a human. */
const RECOMMENDATION_ORDER = [
  "migrate",
  "rebuild",
  "first-sync",
  "collect",
  "w5-unknown-session",
  "backfill",
  "sync-first",
  "sync-reseed",
  "sync-push",
  "sync-pull-own",
  "sync-forget",
  "w5-log",
  "review",
  "eval",
];

function orderRecommendations(recommendations: Recommendation[]): Recommendation[] {
  const rank = (entry: Recommendation) => {
    const index = RECOMMENDATION_ORDER.indexOf(entry.id);
    return index === -1 ? RECOMMENDATION_ORDER.length : index;
  };
  return [...recommendations].sort((a, b) => rank(a) - rank(b));
}

export interface ScryInput {
  database: Database;
  home: string;
  databasePath: string;
  now: Date;
  w5: W5Config;
  windowDays: number;
  /** `[sync]` is present and enabled; false when absent, disabled or unreadable. */
  syncEnabled: boolean;
  /** `HOST_SLUG`; only read when `syncEnabled`. */
  hostSlug?: string;
  /** Skip `quick_check` and the projection replay: the two checks that scale with the database. */
  fast: boolean;
  /** Checks already decided by the caller (reading `tempad.toml`, `[sync]`, the database file). */
  priorChecks: Check[];
  sizeBytes: number;
}

function check(
  id: string,
  title: string,
  status: CheckStatus,
  summary: string,
  details: string[] = [],
): Check {
  return { id, title, status, summary, details };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Runs a read that may hit a projection table which has not been created yet (no event has needed it). */
function safely<T>(fallback: T, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && /no such table|no such column/.test(error.message))
      return fallback;
    throw error;
  }
}

function count(database: Database, sql: string, ...parameters: (string | number)[]): number {
  return safely(0, () => {
    const row = database.query(sql).get(...parameters) as { n: number } | null;
    return row?.n ?? 0;
  });
}

function sourceStats(database: Database, table: string, column: string): SourceStats {
  return safely({ rows: 0, newest: null }, () => {
    const row = database
      .query(`SELECT COUNT(*) AS rows, MAX(${column}) AS newest FROM ${table}`)
      .get() as {
      rows: number;
      newest: string | null;
    };
    return { rows: row.rows, newest: row.newest };
  });
}

function groupCounts(database: Database, sql: string): Record<string, number> {
  return safely({}, () => {
    const result: Record<string, number> = {};
    for (const row of database.query(sql).all() as { key: string; n: number }[])
      result[row.key] = row.n;
    return result;
  });
}

function meta(database: Database, key: string): string | null {
  return safely(null, () => {
    const row = database.query("SELECT value FROM sync_meta WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  });
}

function hoursBetween(from: string, now: Date): number | null {
  const parsed = Date.parse(from);
  return Number.isNaN(parsed) ? null : (now.getTime() - parsed) / HOUR_MS;
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${Math.round(hours / 24)} d`;
}

function normalizeError(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

// --- checks ---------------------------------------------------------------

function schemaCheck(database: Database): {
  check: Check;
  current: boolean;
  version: number;
  latest: number;
} {
  const version = (database.query("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  const latest = Math.max(0, ...loadMigrations().map((migration) => migration.version));
  if (version === latest) {
    return {
      check: check("schema", "Schema", "ok", `version ${version}, current`),
      current: true,
      version,
      latest,
    };
  }
  const behind = version < latest;
  return {
    check: check(
      "schema",
      "Schema",
      "fail",
      behind
        ? `version ${version}, this tempad expects ${latest}; any command that opens the database migrates it`
        : `version ${version} is newer than this tempad (${latest}); upgrade tempad on this host`,
    ),
    current: false,
    version,
    latest,
  };
}

function integrityCheck(database: Database, fast: boolean): Check {
  if (fast)
    return check("integrity", "Integrity", "skip", "skipped by --fast (PRAGMA quick_check)");
  const rows = (database.query("PRAGMA quick_check").all() as { quick_check: string }[]).map(
    (row) => row.quick_check,
  );
  if (rows.length === 1 && rows[0] === "ok")
    return check("integrity", "Integrity", "ok", "quick_check ok");
  return check(
    "integrity",
    "Integrity",
    "fail",
    `quick_check found ${plural(rows.length, "problem")}`,
    rows.slice(0, 5),
  );
}

function projectionsCheck(database: Database, fast: boolean): Check {
  const details: string[] = [];
  let status: CheckStatus = "ok";
  const events = count(database, "SELECT COUNT(*) AS n FROM events");

  // Cursor: every registered projection must have applied the newest event (by uid, the replay order).
  const newest = database
    .query("SELECT id FROM events ORDER BY uid DESC, id DESC LIMIT 1")
    .get() as { id: number } | null;
  const cursors = safely(new Map<string, number>(), () => {
    const map = new Map<string, number>();
    for (const row of database.query("SELECT name, last_event_id FROM projection_state").all() as {
      name: string;
      last_event_id: number;
    }[]) {
      map.set(row.name, row.last_event_id);
    }
    return map;
  });
  if (newest !== null) {
    const behind = listProjections()
      .filter((projection) => cursors.get(projection.name) !== newest.id)
      .map(
        (projection) =>
          `${projection.name} (${cursors.get(projection.name) ?? "no cursor"} != ${newest.id})`,
      );
    if (behind.length > 0) {
      status = "fail";
      details.push(`behind the newest event: ${behind.join(", ")}`);
    }
  }

  if (meta(database, REBUILD_PENDING) !== null) {
    if (status === "ok") status = "warn";
    details.push("a pull added events and no rebuild has run since (sync_meta rebuild_pending)");
  }

  if (fast) {
    details.push("replay compare skipped by --fast");
  } else if (events > 0) {
    const differences = compareProjectionsToReplay(database);
    if (differences.length > 0) {
      status = "fail";
      for (const difference of differences) {
        details.push(
          `${difference.table}: stored ${difference.stored}, replay ${difference.replayed} (${difference.missing} missing, ${difference.extra} extra)`,
        );
      }
    }
  }

  const summary =
    status === "ok"
      ? `${plural(events, "event")} replay to the stored projections${fast ? " (cursors only, --fast)" : ""}`
      : status === "warn"
        ? "projections match their cursors, but a rebuild is pending"
        : "projections do not match the event log";
  return check("projections", "Projections", status, summary, details);
}

function collectorChecks(
  database: Database,
  now: Date,
): { check: Check; collectors: CollectorStats[] } {
  const rows = new Map<string, string>();
  for (const row of database.query("SELECT source, last_sync_at FROM sync_state").all() as {
    source: string;
    last_sync_at: string;
  }[]) {
    rows.set(row.source, row.last_sync_at);
  }
  const collectors: CollectorStats[] = SOURCES.map((source) => {
    const lastSyncAt = rows.get(source) ?? null;
    return {
      source,
      lastSyncAt,
      ageHours: lastSyncAt === null ? null : hoursBetween(lastSyncAt, now),
    };
  });
  const stale = collectors.filter(
    (collector) => collector.ageHours === null || collector.ageHours > COLLECTOR_STALE_HOURS,
  );
  if (stale.length === 0) {
    return {
      check: check(
        "collectors",
        "Collectors",
        "ok",
        `all synced within ${COLLECTOR_STALE_HOURS} h`,
      ),
      collectors,
    };
  }
  return {
    check: check(
      "collectors",
      "Collectors",
      "warn",
      `${stale.map((collector) => collector.source).join(", ")} not synced in over ${COLLECTOR_STALE_HOURS} h`,
      stale.map((collector) =>
        collector.ageHours === null
          ? `${collector.source}: never synced`
          : `${collector.source}: last sync ${formatAge(collector.ageHours)} ago`,
      ),
    ),
    collectors,
  };
}

interface QueueResult {
  check: Check;
  recommendations: Recommendation[];
  jobs: W5Stats["jobs"];
  failedLast7Days: number;
  stuck: number;
}

function queueCheck(database: Database, now: Date, home: string): QueueResult {
  const states = groupCounts(
    database,
    "SELECT state AS key, COUNT(*) AS n FROM w5_jobs GROUP BY state",
  );
  const jobs = {
    queued: states.queued ?? 0,
    running: states.running ?? 0,
    done: states.done ?? 0,
    failed: states.failed ?? 0,
  };
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const stuckBefore = new Date(now.getTime() - STUCK_JOB_HOURS * HOUR_MS).toISOString();
  const failedLast7Days = count(
    database,
    "SELECT COUNT(*) AS n FROM w5_jobs WHERE state = 'failed' AND COALESCE(finished_at, requested_at) >= ?",
    since,
  );
  const stuck = count(
    database,
    "SELECT COUNT(*) AS n FROM w5_jobs WHERE state = 'running' AND claimed_at IS NOT NULL AND claimed_at < ?",
    stuckBefore,
  );

  const grouped = new Map<string, number>();
  for (const row of safely<{ error: string | null; n: number }[]>(
    [],
    () =>
      database
        .query(
          "SELECT error, COUNT(*) AS n FROM w5_jobs WHERE state = 'failed' AND COALESCE(finished_at, requested_at) >= ? GROUP BY error",
        )
        .all(since) as { error: string | null; n: number }[],
  )) {
    const key = normalizeError(row.error ?? "(no error recorded)");
    grouped.set(key, (grouped.get(key) ?? 0) + row.n);
  }
  const top = [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const recommendations: Recommendation[] = [];
  const details: string[] = top.map(([message, n]) => `${n} x ${message}`);
  if (stuck > 0)
    details.push(`${plural(stuck, "job")} claimed over ${STUCK_JOB_HOURS} h ago and still running`);

  let status: CheckStatus = "ok";
  let summary = `${plural(jobs.queued, "job")} queued, none failed in the last 7 days`;
  if (failedLast7Days > 0 || stuck > 0) {
    status = "warn";
    summary = `${failedLast7Days} failed in the last 7 days, ${stuck} stuck running`;
  }
  if (failedLast7Days > 0) {
    recommendations.push({
      id: "w5-log",
      command: `tail -n 50 ${home}/logs/w5.log`,
      reason: `${failedLast7Days} classification jobs failed in the last 7 days; the log has the error`,
    });
    const unknown = top.some(([message]) => message.includes("unknown claude session"));
    if (unknown) {
      recommendations.push({
        id: "w5-unknown-session",
        command: "tempad sync claude",
        reason:
          "jobs failed with `unknown claude session`: the session was not in the database when the job ran; collect it first, then backfill",
      });
    }
  }
  return {
    check: check("w5-queue", "Classification jobs", status, summary, details),
    recommendations,
    jobs,
    failedLast7Days,
    stuck,
  };
}

interface CoverageResult {
  check: Check;
  recommendations: Recommendation[];
  stats: Pick<
    W5Stats,
    | "sessionsInWindow"
    | "windowsCovered"
    | "windowsPending"
    | "windowsInFlight"
    | "pendingSessions"
    | "oldestPendingSessionEndedAt"
    | "ownHostOnly"
  >;
}

function coverageCheck(input: ScryInput): CoverageResult {
  const { database, now, w5, windowDays } = input;
  const ownHostOnly = input.syncEnabled && input.hostSlug !== undefined;
  const cutoff = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const sessions = selectBackfillSessions(database, {
    cutoff,
    hostSlug: ownHostOnly ? input.hostSlug : undefined,
  });
  const planned = planBackfillWindows(database, sessions, {
    windowMinutes: w5.throttleMinutes * 3,
  });
  const inFlightAfter = new Date(now.getTime() - IN_FLIGHT_MS).toISOString();
  const covered = planned.filter((window) => window.covered);
  const pending = planned.filter((window) => !window.covered);
  const inFlight = pending.filter((window) => window.endedAt >= inFlightAfter);
  const stale = pending.filter((window) => window.endedAt < inFlightAfter);

  const endedAt = new Map(sessions.map((session) => [session.id, session.ended_at]));
  const pendingSessions = new Set(stale.map((window) => window.sessionId));
  let oldest: string | null = null;
  for (const id of pendingSessions) {
    const ended = endedAt.get(id);
    if (ended !== undefined && (oldest === null || ended < oldest)) oldest = ended;
  }

  const stats = {
    ownHostOnly,
    sessionsInWindow: sessions.length,
    windowsCovered: covered.length,
    windowsPending: stale.length,
    windowsInFlight: inFlight.length,
    pendingSessions: pendingSessions.size,
    oldestPendingSessionEndedAt: oldest,
  };
  const scope = ownHostOnly ? `host ${input.hostSlug}, ` : "";
  if (stale.length === 0) {
    return {
      check: check(
        "w5-coverage",
        "Classification coverage",
        "ok",
        `${plural(sessions.length, "session")} ended in the last ${windowDays} days (${scope}${covered.length} windows), all classified${inFlight.length > 0 ? `; ${plural(inFlight.length, "window")} still in flight` : ""}`,
      ),
      recommendations: [],
      stats,
    };
  }
  const oldestEnd = oldest === null ? now.getTime() : Date.parse(oldest);
  const days = Math.max(1, Math.ceil((now.getTime() - oldestEnd) / DAY_MS));
  return {
    check: check(
      "w5-coverage",
      "Classification coverage",
      "warn",
      `${plural(stale.length, "window")} in ${plural(pendingSessions.size, "session")} not classified (${scope}last ${windowDays} days)`,
      [`oldest unclassified session ended ${oldest ?? "unknown"}`],
    ),
    recommendations: [
      {
        id: "backfill",
        command: `tempad w5 backfill --days ${days}`,
        reason: `${plural(stale.length, "window")} in ${plural(pendingSessions.size, "session")} have no trace; spends one classifier call per window`,
      },
    ],
    stats,
  };
}

interface AttentionResult {
  check: Check;
  recommendations: Recommendation[];
  expiredUnanswered: number;
  doubtedLast7Days: number;
  unconfirmed: number;
}

/** What `tempad review` would list, counted the same way (it hides an expired `declare` question when the session ever declared). */
function attentionCheck(database: Database, now: Date): AttentionResult {
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const doubted = count(
    database,
    `SELECT COUNT(*) AS n FROM traces
       JOIN stints ON stints.id = traces.stint_id
      WHERE traces.doubt IS NOT NULL AND traces.retracted_at IS NULL AND traces.started_at >= ?
        AND stints.dismissed_at IS NULL AND stints.retracted_at IS NULL`,
    since,
  );
  const expired = safely<{ kind: string; session_id: string | null }[]>(
    [],
    () =>
      database.query("SELECT kind, session_id FROM questions WHERE state = 'expired'").all() as {
        kind: string;
        session_id: string | null;
      }[],
  );
  const expiredShown = expired.filter(
    (question) =>
      !(
        question.kind === "declare" &&
        question.session_id !== null &&
        sessionEverDeclared(database, question.session_id)
      ),
  ).length;
  const unconfirmed = count(
    database,
    "SELECT COUNT(*) AS n FROM quests WHERE confirmed = 0 AND retracted_at IS NULL",
  );

  const total = doubted + expiredShown + unconfirmed;
  const parts = [
    `${plural(expiredShown, "expired question")}`,
    `${plural(unconfirmed, "unconfirmed quest")}`,
    `${plural(doubted, "doubted trace")} in the last 7 days`,
  ];
  const recommendations: Recommendation[] = [];
  if (total > 0) {
    recommendations.push({
      id: "review",
      command: "tempad review",
      reason: `${parts.join(", ")} wait for a human answer; none of it blocks reports`,
    });
  }
  return {
    check: check(
      "attention",
      "Needs a human",
      total === 0 ? "ok" : "warn",
      total === 0 ? "nothing waiting for an answer" : parts.join(", "),
    ),
    recommendations,
    expiredUnanswered: expiredShown,
    doubtedLast7Days: doubted,
    unconfirmed,
  };
}

interface SyncResult {
  check: Check | null;
  recommendations: Recommendation[];
  stats: SyncStats | null;
}

function syncCheck(input: ScryInput): SyncResult {
  const { database } = input;
  const mirrorTriggers = meta(database, MIRROR_SYNC_ENABLED) !== null;
  if (!input.syncEnabled && !mirrorTriggers)
    return { check: null, recommendations: [], stats: null };

  const dirtyEvents = count(database, "SELECT COUNT(*) AS n FROM events WHERE sync_dirty = 1");
  let dirtyMirrors = 0;
  for (const table of SYNCED_UPSERT_TABLES) {
    dirtyMirrors += count(database, `SELECT COUNT(*) AS n FROM ${table.name} WHERE sync_dirty = 1`);
  }
  const dirtyTombstones = count(
    database,
    "SELECT COUNT(*) AS n FROM sync_tombstones WHERE sync_dirty = 1",
  );
  const probe = meta(database, PUSH_PROBE_ROW);
  let lastPushedStamp: string | null = null;
  if (probe !== null) {
    try {
      lastPushedStamp = (JSON.parse(probe) as { stamp?: string }).stamp ?? null;
    } catch {
      lastPushedStamp = null;
    }
  }
  const pending = {
    reseed: meta(database, RESEED_PENDING) !== null,
    pullOwn: meta(database, PULL_OWN_PENDING) !== null,
    rebuild: meta(database, REBUILD_PENDING) !== null,
  };
  const forgottenServers = count(
    database,
    "SELECT COUNT(*) AS n FROM sync_meta WHERE key LIKE ? ESCAPE '\\'",
    `${FORGOTTEN_SERVER_PREFIX.replace(/[\\%_]/g, "\\$&")}%`,
  );
  const stats: SyncStats = {
    enabled: input.syncEnabled,
    mirrorTriggers,
    serverKnown: meta(database, SERVER_ID) !== null,
    dirty: { events: dirtyEvents, mirrors: dirtyMirrors, tombstones: dirtyTombstones },
    lastPushedStamp,
    pending,
    forgottenServers,
  };

  if (!input.syncEnabled) {
    return {
      check: check(
        "sync",
        "Sync",
        "warn",
        "[sync] is not configured but this database still carries sync state (mirror triggers)",
        ["the remote still holds this host's rows; to leave sync for good, run the command below"],
      ),
      recommendations: [
        {
          id: "sync-forget",
          command: "tempad sync --forget",
          reason:
            "[sync] was removed but the mirror triggers and tombstones remain; ignore this if you plan to re-enable sync",
        },
      ],
      stats,
    };
  }

  const recommendations: Recommendation[] = [];
  const details: string[] = [];
  const dirtyTotal = dirtyEvents + dirtyMirrors + dirtyTombstones;
  if (!mirrorTriggers) {
    details.push(
      "sync has never run on this host (no mirror_sync_enabled marker); the dirty counts below do not apply yet",
    );
    recommendations.push({
      id: "sync-first",
      command: "tempad sync",
      reason: "[sync] is configured but this host has never pushed or pulled",
    });
  } else {
    if (dirtyTotal > 0) {
      details.push(
        `not yet pushed: ${plural(dirtyEvents, "event")}, ${plural(dirtyMirrors, "mirror row")}, ${plural(dirtyTombstones, "tombstone")}`,
      );
      recommendations.push({
        id: "sync-push",
        command: "tempad sync --push",
        reason: `${dirtyTotal} local changes have not reached the server`,
      });
    }
    if (pending.reseed) {
      details.push("a re-seed is pending: the server was replaced or restored");
      recommendations.push({
        id: "sync-reseed",
        command: "tempad sync",
        reason:
          "the server looked new or restored; one full run re-sends everything and clears the marker",
      });
    }
    if (pending.pullOwn) {
      details.push("this host's own history has not been pulled back yet");
      recommendations.push({
        id: "sync-pull-own",
        command: "tempad sync --pull",
        reason: "a pull of this host's own rows is pending (reinstall or restored backup)",
      });
    }
  }
  if (lastPushedStamp !== null)
    details.push(`last pushed row stamped ${lastPushedStamp} (the database records no pull time)`);
  const status: CheckStatus = recommendations.length > 0 ? "warn" : "ok";
  return {
    check: check(
      "sync",
      "Sync",
      status,
      status === "ok" ? "nothing waiting to push, no re-seed pending" : "sync has work waiting",
      details,
    ),
    recommendations,
    stats,
  };
}

// --- stats ----------------------------------------------------------------

function intentStats(
  database: Database,
  windowSince: string,
  attention: AttentionResult,
): IntentStats {
  return {
    events: count(database, "SELECT COUNT(*) AS n FROM events"),
    quests: groupCounts(
      database,
      "SELECT state AS key, COUNT(*) AS n FROM quests WHERE retracted_at IS NULL GROUP BY state",
    ),
    questsUnconfirmed: attention.unconfirmed,
    stints: {
      open: count(
        database,
        "SELECT COUNT(*) AS n FROM stints WHERE retracted_at IS NULL AND dismissed_at IS NULL AND closed_at IS NULL",
      ),
      closed: count(
        database,
        "SELECT COUNT(*) AS n FROM stints WHERE retracted_at IS NULL AND dismissed_at IS NULL AND closed_at IS NOT NULL",
      ),
      dismissed: count(
        database,
        "SELECT COUNT(*) AS n FROM stints WHERE retracted_at IS NULL AND dismissed_at IS NOT NULL",
      ),
    },
    stintsWithoutQuestInWindow: count(
      database,
      "SELECT COUNT(*) AS n FROM stints WHERE retracted_at IS NULL AND dismissed_at IS NULL AND quest_id IS NULL AND opened_at >= ?",
      windowSince,
    ),
    tracesInWindow: count(
      database,
      "SELECT COUNT(*) AS n FROM traces WHERE retracted_at IS NULL AND started_at >= ?",
      windowSince,
    ),
    doubtedTracesLast7Days: attention.doubtedLast7Days,
    questions: groupCounts(
      database,
      "SELECT state AS key, COUNT(*) AS n FROM questions GROUP BY state",
    ),
    questionsExpiredUnanswered: attention.expiredUnanswered,
  };
}

function w5Stats(
  database: Database,
  windowDays: number,
  windowSince: string,
  coverage: CoverageResult,
  queue: QueueResult,
  sessionIdsInWindow: string[],
): W5Stats {
  const withTraces = new Set(
    safely<{ session_id: string }[]>(
      [],
      () =>
        database
          .query(
            "SELECT DISTINCT session_id FROM traces WHERE retracted_at IS NULL AND session_id IS NOT NULL AND started_at >= ?",
          )
          .all(windowSince) as { session_id: string }[],
    ).map((row) => row.session_id),
  );
  const declared = sessionIdsInWindow.filter((id) => hasAnyDeclaration(database, id)).length;
  return {
    windowDays,
    ...coverage.stats,
    sessionsWithTraces: sessionIdsInWindow.filter((id) => withTraces.has(id)).length,
    sessionsDeclared: declared,
    sessionsUndeclared: sessionIdsInWindow.length - declared,
    jobs: queue.jobs,
    jobsFailedLast7Days: queue.failedLast7Days,
    jobsStuckRunning: queue.stuck,
  };
}

// --- entry point ------------------------------------------------------------

/**
 * Reads the database and answers: is the data healthy, what does it hold, and
 * should a backfill or an eval run. Never writes: `input.database` is expected
 * to be a read-only connection, and every query here is a SELECT or a PRAGMA
 * that reads.
 */
export function scry(input: ScryInput): ScryReport {
  const started = performance.now();
  const { database, now } = input;
  const checks: Check[] = [...input.priorChecks];
  const recommendations: Recommendation[] = [];
  const notes: string[] = [];
  const base = {
    generatedAt: now.toISOString(),
    home: input.home,
    windowDays: input.windowDays,
  };
  const finish = (stats: ScryStats | null): ScryReport => ({
    ...base,
    ok: !checks.some((entry) => entry.status === "fail"),
    checks,
    stats,
    recommendations: orderRecommendations(recommendations),
    notes,
    durationMs: Math.round(performance.now() - started),
  });

  const schema = schemaCheck(database);
  checks.push(schema.check);
  const database_ = {
    path: input.databasePath,
    sizeBytes: input.sizeBytes,
    schemaVersion: schema.version,
    latestSchemaVersion: schema.latest,
  };
  if (!schema.current) {
    if (schema.version < schema.latest) {
      recommendations.push({
        id: "migrate",
        command: "tempad rebuild",
        reason:
          "opens the database, which applies the pending migrations, then rebuilds the projections (always safe)",
      });
    }
    notes.push(
      "The other checks were skipped: they read tables this schema version does not define the same way.",
    );
    return finish(null);
  }

  // One snapshot for every read below, so a hook writing while scry runs cannot make two numbers disagree.
  database.exec("BEGIN");
  try {
    checks.push(integrityCheck(database, input.fast));
    checks.push(projectionsCheck(database, input.fast));
    const projectionsFailed = checks.at(-1)?.status === "fail";
    if (projectionsFailed) {
      recommendations.push({
        id: "rebuild",
        command: "tempad rebuild",
        reason:
          "projections are derived from the event log; a rebuild replays it and is always safe",
      });
    }

    const collectors = collectorChecks(database, now);
    checks.push(collectors.check);
    const staleSources = collectors.collectors
      .filter(
        (collector) => collector.ageHours === null || collector.ageHours > COLLECTOR_STALE_HOURS,
      )
      .map((collector) => collector.source);
    if (staleSources.length > 0) {
      recommendations.push({
        id: "collect",
        command: staleSources.length === 1 ? `tempad sync ${staleSources[0]}` : "tempad sync",
        reason: `${staleSources.join(", ")} not collected in over ${COLLECTOR_STALE_HOURS} h; reports and coverage lag behind the work`,
      });
    }

    const queue = queueCheck(database, now, input.home);
    checks.push(queue.check);
    // A stale-collector recommendation already covers `sync claude`.
    const collecting = recommendations.some((entry) => entry.id === "collect");
    recommendations.push(
      ...queue.recommendations.filter(
        (entry) => !(collecting && entry.id === "w5-unknown-session"),
      ),
    );

    const coverage = coverageCheck(input);
    checks.push(coverage.check);
    recommendations.push(...coverage.recommendations);

    const attention = attentionCheck(database, now);
    checks.push(attention.check);
    recommendations.push(...attention.recommendations);

    const sync = syncCheck(input);
    if (sync.check) checks.push(sync.check);
    recommendations.push(...sync.recommendations);

    // Eval: the database records no classifier model, prompt or config, so it cannot say that an eval is due.
    const windowSince = new Date(now.getTime() - input.windowDays * DAY_MS).toISOString();
    const sessionIds = selectBackfillSessions(database, {
      cutoff: windowSince,
      hostSlug: coverage.stats.ownHostOnly ? input.hostSlug : undefined,
    }).map((session) => session.id);
    const stats: ScryStats = {
      database: database_,
      sources: {
        claudeSessions: sourceStats(database, "claude_sessions", "started_at"),
        claudeMessages: sourceStats(database, "claude_messages", "ts"),
        githubCommits: sourceStats(database, "gh_commits", "authored_at"),
        githubPullRequests: sourceStats(database, "gh_pull_requests", "updated_at"),
        mondayItems: sourceStats(database, "monday_items", "updated_at"),
      },
      collectors: collectors.collectors,
      intent: intentStats(database, windowSince, attention),
      w5: w5Stats(database, input.windowDays, windowSince, coverage, queue, sessionIds),
      sync: sync.stats,
    };

    const evalDays = Math.min(input.windowDays, EVAL_WINDOW_DAYS);
    const evalFrom = new Date(now.getTime() - evalDays * DAY_MS).toISOString().slice(0, 10);
    const evalTo = now.toISOString().slice(0, 10);
    const baselineSessions = stats.w5?.sessionsWithTraces ?? 0;
    if (baselineSessions >= EVAL_MIN_SESSIONS) {
      recommendations.push({
        id: "eval",
        command: `tempad w5 eval --from ${evalFrom} --to ${evalTo}`,
        condition:
          "only after changing [w5] (model, backend, mode), the classifier prompts, or upgrading tempad",
        reason: `re-classifies a copy of the last ${plural(evalDays, "day")} (${plural(baselineSessions, "session")} with traces) and compares it with what is stored; spends one classifier call per window and never touches the real database`,
      });
      notes.push(
        "Eval: the database does not record which model, prompt or config produced a trace, so the data cannot say one is due; run it when you change the classifier.",
      );
    } else {
      notes.push(
        `Eval: not recommended; only ${plural(baselineSessions, "session")} with traces in the last ${input.windowDays} days (need ${EVAL_MIN_SESSIONS}), too little to compare against.`,
      );
    }
    return finish(stats);
  } finally {
    database.exec("ROLLBACK");
  }
}
