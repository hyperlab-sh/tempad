import type { Database } from "bun:sqlite";
import type { HomeConfig } from "../config/env";
import type { W5Config } from "../intent/config";
import { hasAnyDeclaration } from "../intent/declarations";
import { applyIncremental, ensureTables } from "../intent/projections";
import { registerAllProjections } from "../intent/projections/register";
import { EventStore } from "../intent/store";
import { applyResult } from "./apply";
import type { Classifier } from "./classifier";
import { writeSessionNote } from "./jobs";
import { closeIdleStints } from "./lifecycle";
import { buildWindow } from "./window";

registerAllProjections();

export interface BackfillOptions {
  days: number;
  now: string;
  log: (line: string) => void;
  force?: boolean;
  /** Explicit lower bound, overriding the `days`-derived cutoff when given. */
  from?: string;
  /**
   * Explicit, exclusive upper bound on both the session query and each
   * session's message window -- callers passing a bare date must normalize
   * it to the start of the next day themselves (see `eval.ts`'s
   * `normalizeEvalRange`), since a raw bare date compared with `<` would
   * exclude the whole day instead of including it.
   */
  to?: string;
  /**
   * When set, only sessions that ran on this host (`claude_sessions.host_slug`)
   * are classified. Push sync passes the local `HOST_SLUG` so a session is
   * classified once, on the machine holding its transcript, and its traces
   * reach the other hosts as events (docs/specs/push-sync.md, "w5 stays
   * host-local"). Unset: every session, regardless of host.
   */
  hostSlug?: string;
}

export interface BackfillResult {
  sessionsClassified: number;
  sessionsSkipped: number;
  windowsClassified: number;
  windowsFailed: number;
  windowsSkipped: number;
  doubts: number;
  unknownStintIds: number;
  overlapDropped: number;
  questProposedOnMatched: number;
  selectorDefaulted: number;
  selectorAmbiguous: number;
  /** Sessions classified this run whose `modeFor` was `"declared"`. */
  sessionsDeclared: number;
  /** Sessions classified this run whose `modeFor` was `"inferred"`. */
  sessionsInferred: number;
}

export interface SessionRow {
  id: string;
  ended_at: string;
}

/**
 * The sessions a backfill run looks at: ended on or after `cutoff` (and before
 * `to`, when given), on `hostSlug` when set, oldest first. `backfill` and
 * `tempad scry` both call it, so scry's "windows still to classify" can never
 * select a different set of sessions than the run it recommends.
 */
export function selectBackfillSessions(
  database: Database,
  options: { cutoff: string; to?: string; hostSlug?: string },
): SessionRow[] {
  const clauses = ["ended_at >= ?"];
  const parameters: string[] = [options.cutoff];
  if (options.to) {
    clauses.push("ended_at < ?");
    parameters.push(options.to);
  }
  if (options.hostSlug !== undefined) {
    clauses.push("host_slug = ?");
    parameters.push(options.hostSlug);
  }
  return database
    .query(
      `SELECT id, ended_at FROM claude_sessions WHERE ${clauses.join(" AND ")} ORDER BY started_at ASC`,
    )
    .all(...parameters) as SessionRow[];
}

/**
 * Primary path: an explicit `w5_windows` row for this exact window (see
 * `src/intent/projections/window.ts`). Legacy fallback, for windows
 * classified before `window.classified` existed: a live (non-retracted)
 * trace nested inside the window's bounds. A database with traces already
 * classified under the old scheme has no `w5_windows` rows at all, so
 * without this fallback every one of those windows would look uncovered
 * and get reclassified (and re-duplicated) the first time backfill runs
 * post-upgrade.
 */
export function isWindowCovered(
  database: Database,
  sessionId: string,
  windowStartedAt: string,
  windowEndedAt: string,
): boolean {
  const windowRow = database
    .query(
      "SELECT rowid FROM w5_windows WHERE session_id = ? AND started_at = ? AND ended_at = ? LIMIT 1",
    )
    .get(sessionId, windowStartedAt, windowEndedAt) as { rowid: number } | null;
  if (windowRow !== null) return true;

  const traceRow = database
    .query(
      `SELECT id FROM traces
       WHERE session_id = ? AND retracted_at IS NULL
         AND started_at >= ? AND ended_at <= ?
       LIMIT 1`,
    )
    .get(sessionId, windowStartedAt, windowEndedAt) as { id: string } | null;
  return traceRow !== null;
}

export function chunkByWindow<T extends { ts: string }>(
  messages: T[],
  windowMinutes: number,
): T[][] {
  if (messages.length === 0) return [];
  const chunks: T[][] = [];
  let current: T[] = [];
  let windowStart: number | null = null;

  for (const message of messages) {
    const ts = Date.parse(message.ts);
    if (windowStart === null || ts - windowStart > windowMinutes * 60_000) {
      if (current.length > 0) chunks.push(current);
      current = [message];
      windowStart = ts;
    } else {
      current.push(message);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface PlannedWindow {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  /** What `isWindowCovered` answers: a re-run would skip this window. */
  covered: boolean;
}

/**
 * The windows a backfill over `sessions` would visit and whether each is
 * already covered, without classifying anything: the same message list
 * `buildWindow` reads for a whole session (newest 5000 with text, oldest
 * first, below `to` when given), the same `chunkByWindow`, the same coverage
 * rule as `isWindowCovered` (answered from two table reads instead of a
 * `traces` scan per window). Read-only; `tempad scry` uses it to say how much a
 * backfill would do. `test/w5/backfill.test.ts` pins that it agrees with a
 * real run, so a change to either side fails there.
 */
export function planBackfillWindows(
  database: Database,
  sessions: readonly SessionRow[],
  options: { windowMinutes: number; to?: string },
): PlannedWindow[] {
  // `isWindowCovered` per chunk scans `traces` (no `session_id` index) once per
  // window; for a plan over hundreds of sessions, read both tables once and
  // answer the same two questions from memory.
  // The projection tables are created lazily by the first event that needs
  // them, so a database that never classified anything has neither: every
  // window is then uncovered, as it is for `isWindowCovered`'s caller after
  // `ensureTables`.
  const hasTable = (name: string) =>
    database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    null;
  const wanted = new Set(sessions.map((session) => session.id));
  const classified = new Set<string>();
  for (const row of (hasTable("w5_windows")
    ? database.query("SELECT session_id, started_at, ended_at FROM w5_windows").all()
    : []) as {
    session_id: string;
    started_at: string;
    ended_at: string;
  }[]) {
    if (wanted.has(row.session_id))
      classified.add(`${row.session_id}\u0000${row.started_at}\u0000${row.ended_at}`);
  }
  const traces = new Map<string, { started_at: string; ended_at: string }[]>();
  for (const row of (hasTable("traces")
    ? database
        .query(
          "SELECT session_id, started_at, ended_at FROM traces WHERE retracted_at IS NULL AND session_id IS NOT NULL",
        )
        .all()
    : []) as { session_id: string; started_at: string; ended_at: string }[]) {
    if (!wanted.has(row.session_id)) continue;
    const list = traces.get(row.session_id);
    if (list) list.push(row);
    else traces.set(row.session_id, [row]);
  }

  const messageTimestamps = database.query(
    `SELECT ts FROM claude_messages
      WHERE session_id = ? AND text_preview IS NOT NULL
      ORDER BY ts DESC LIMIT 5000`,
  );
  const planned: PlannedWindow[] = [];
  for (const session of sessions) {
    const rows = (messageTimestamps.all(session.id) as { ts: string }[]).reverse();
    const bounded = options.to ? rows.filter((row) => row.ts < (options.to as string)) : rows;
    const sessionTraces = traces.get(session.id) ?? [];
    for (const chunk of chunkByWindow(bounded, options.windowMinutes)) {
      const startedAt = chunk[0]?.ts ?? session.ended_at;
      const endedAt = chunk.at(-1)?.ts ?? session.ended_at;
      planned.push({
        sessionId: session.id,
        startedAt,
        endedAt,
        covered:
          classified.has(`${session.id}\u0000${startedAt}\u0000${endedAt}`) ||
          sessionTraces.some((trace) => trace.started_at >= startedAt && trace.ended_at <= endedAt),
      });
    }
  }
  return planned;
}

export async function backfill(
  database: Database,
  _config: HomeConfig,
  intentConfig: W5Config,
  classifier: Classifier,
  options: BackfillOptions,
): Promise<BackfillResult> {
  ensureTables(database);
  const store = new EventStore(database);
  const cutoff =
    options.from ??
    new Date(Date.parse(options.now) - options.days * 24 * 60 * 60 * 1000).toISOString();

  const sessions = selectBackfillSessions(database, {
    cutoff,
    to: options.to,
    hostSlug: options.hostSlug,
  });

  let sessionsClassified = 0;
  let sessionsSkipped = 0;
  let windowsClassified = 0;
  let windowsFailed = 0;
  let windowsSkipped = 0;
  let doubts = 0;
  let unknownStintIds = 0;
  let overlapDropped = 0;
  let questProposedOnMatched = 0;
  let selectorDefaulted = 0;
  let selectorAmbiguous = 0;
  const windowMinutes = intentConfig.throttleMinutes * 3;

  // Windows are classified in chronological order *across* sessions, not
  // session by session. Two sessions running the same afternoon interleave in
  // real time; processing one to its end before starting the other would show a
  // window stints that, from its own point in time, had not happened yet --
  // the same future-leak `windowEnd` bounds inside a single window. Each
  // session's per-chunk `sinceTs` chain still holds, because a chunk's overlap
  // tail is derived from its own session's previous chunk, not from whatever
  // window happened to run before it.
  interface PendingWindow {
    session: SessionRow;
    chunk: { ts: string; role: string; text: string }[];
    /** Index within the session's own chunk list, as the failure log reports it. */
    index: number;
    startedAt: string;
    endedAt: string;
    /** Last message of this session's previous chunk; the overlap tail's cut. */
    previousChunkEnd: string | null;
  }

  const pending: PendingWindow[] = [];

  /**
   * Decided once per session, never per chunk: a session either declares
   * something somewhere in its span or it never does. A session that declares
   * partway through runs in declared mode for its *whole* span -- its earlier
   * chunks take the "no declaration yet" path (a `declare` question, traces with
   * no quest) rather than the fallback, which is only for sessions that declare
   * nothing, ever. This is exactly what keeps inferred quests off the stints
   * of a declared session.
   */
  const sessionModes = new Map<string, "declared" | "inferred">();
  const modeFor = (sessionId: string): "declared" | "inferred" => {
    const cached = sessionModes.get(sessionId);
    if (cached !== undefined) return cached;
    const mode: "declared" | "inferred" =
      intentConfig.mode === "inferred" ||
      (intentConfig.inferenceFallback && !hasAnyDeclaration(database, sessionId))
        ? "inferred"
        : "declared";
    sessionModes.set(sessionId, mode);
    return mode;
  };

  for (const session of sessions) {
    const fullWindow = buildWindow(database, {
      sessionId: session.id,
      mode: modeFor(session.id),
      sinceTs: null,
      maxMessages: 5000,
      memoryHours: intentConfig.memoryHours,
      memoryStints: intentConfig.memoryStints,
      overlapMessages: intentConfig.overlapMessages,
      // Only the message list is used from this window; the slice is rebuilt per
      // chunk below with that chunk's own end as the bound.
      windowEnd: options.to ?? session.ended_at,
    });
    const boundedMessages = options.to
      ? fullWindow.messages.filter((message) => message.ts < (options.to as string))
      : fullWindow.messages;
    const chunks = chunkByWindow(boundedMessages, windowMinutes);

    let sessionPending = 0;
    for (const [index, chunk] of chunks.entries()) {
      const startedAt = chunk[0]?.ts ?? session.ended_at;
      const endedAt = chunk.at(-1)?.ts ?? session.ended_at;
      const covered = options.force
        ? false
        : isWindowCovered(database, session.id, startedAt, endedAt);
      if (covered) {
        windowsSkipped += 1;
        continue;
      }
      sessionPending += 1;
      pending.push({
        session,
        chunk,
        index,
        startedAt,
        endedAt,
        previousChunkEnd: index > 0 ? (chunks[index - 1]?.at(-1)?.ts ?? null) : null,
      });
    }

    if (chunks.length > 0 && sessionPending === 0) {
      sessionsSkipped += 1;
      options.log(`backfill: skipping ${session.id} (already covered)`);
    }
  }

  pending.sort((left, right) =>
    left.startedAt === right.startedAt
      ? left.session.id.localeCompare(right.session.id)
      : left.startedAt < right.startedAt
        ? -1
        : 1,
  );

  const sessionSuccesses = new Map<string, number>();
  const sessionPendingCounts = new Map<string, number>();
  for (const window of pending) {
    sessionPendingCounts.set(
      window.session.id,
      (sessionPendingCounts.get(window.session.id) ?? 0) + 1,
    );
  }

  for (const { session, chunk, index, startedAt, endedAt, previousChunkEnd } of pending) {
    closeIdleStints(store, database, {
      sessionId: session.id,
      windowStartedAt: startedAt,
      idleMinutes: intentConfig.stintIdleMinutes,
      stintMinMinutes: intentConfig.stintMinMinutes,
    });

    // The slice is rebuilt per chunk, after the previous chunk's applyResult and
    // session note landed: chunk n+1 must see the stints chunk n opened or
    // closed, exactly as a live run sees the previous hook invocation's work.
    // `sinceTs` is this session's previous chunk's last message, so the overlap
    // tail is the messages before this chunk, never this chunk's own; `messages`
    // is overridden because the chunk's bounds, not `sinceTs`, decide what it
    // classifies.
    const chunkWindow = {
      ...buildWindow(database, {
        sessionId: session.id,
        mode: modeFor(session.id),
        sinceTs: previousChunkEnd,
        maxMessages: 5000,
        memoryHours: intentConfig.memoryHours,
        memoryStints: intentConfig.memoryStints,
        overlapMessages: intentConfig.overlapMessages,
        windowEnd: endedAt,
      }),
      messages: chunk,
    };

    try {
      let result: Awaited<ReturnType<typeof classifier.classify>>;
      try {
        result = await classifier.classify(chunkWindow);
      } catch {
        result = await classifier.classify(chunkWindow);
      }
      const applied = applyResult(store, database, chunkWindow, result, {
        actor: "backfill",
        askingEnabled: false,
        now: options.now,
        log: options.log,
        mode: modeFor(session.id),
        stintMinMinutes: intentConfig.stintMinMinutes,
      });
      doubts += applied.doubts;
      unknownStintIds += applied.unknownStintIds;
      overlapDropped += applied.overlapDropped;
      questProposedOnMatched += applied.questProposedOnMatched;
      selectorDefaulted += result.selectorDefaulted ?? 0;
      selectorAmbiguous += result.selectorAmbiguous ?? 0;
      writeSessionNote(database, session.id, result.sessionNote, options.now);
      applyIncremental(
        database,
        store.append({
          actor: "backfill",
          kind: "window.classified",
          subject: session.id,
          sessionId: session.id,
          payload: { session: session.id, startedAt, endedAt },
          at: options.now,
        }),
      );
      windowsClassified += 1;
      sessionSuccesses.set(session.id, (sessionSuccesses.get(session.id) ?? 0) + 1);
    } catch (error) {
      windowsFailed += 1;
      const message = error instanceof Error ? error.message : String(error);
      options.log(`backfill: failed ${session.id} window ${index}: ${message}`);
    }
  }

  let sessionsDeclared = 0;
  let sessionsInferred = 0;
  for (const session of sessions) {
    if ((sessionSuccesses.get(session.id) ?? 0) > 0) {
      sessionsClassified += 1;
      options.log(
        `backfill: classified ${session.id} (${sessionPendingCounts.get(session.id) ?? 0} window(s))`,
      );
      if (modeFor(session.id) === "declared") sessionsDeclared += 1;
      else sessionsInferred += 1;
    }
  }

  return {
    sessionsClassified,
    sessionsSkipped,
    windowsClassified,
    windowsFailed,
    windowsSkipped,
    doubts,
    unknownStintIds,
    overlapDropped,
    questProposedOnMatched,
    selectorDefaulted,
    selectorAmbiguous,
    sessionsDeclared,
    sessionsInferred,
  };
}
