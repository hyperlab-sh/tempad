import type { Database } from "bun:sqlite";
import type { HomeConfig } from "../config/env";
import type { W5Config } from "../intent/config";
import { hasAnyDeclaration } from "../intent/declarations";
import { applyIncremental, ensureTables } from "../intent/projections";
import { registerAllProjections } from "../intent/projections/register";
import { EventStore } from "../intent/store";
import { effectiveSessionKind } from "../sessions/kind";
import { applyResult } from "./apply";
import type { Classifier } from "./classifier";
import { writeSessionNote } from "./jobs";
import { closeIdleStints } from "./lifecycle";
import {
  declaredQuestIds,
  isProtectedQuest,
  type PlanTrace,
  replaceStaleWindow,
  resolveStaleWindows,
  type StaleDecision,
} from "./stale";
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
  /** Doubts recorded but not asked (no trigger, or an unrecognized alias); see `AppliedSummary`. */
  doubtsSilent: number;
  unknownStintIds: number;
  overlapDropped: number;
  questProposedOnMatched: number;
  questAttachedOnMatched: number;
  selectorDefaulted: number;
  boundsClamped: number;
  guessDefaulted: number;
  sessionNoteTruncated: number;
  selectorAmbiguous: number;
  selectorRepaired: number;
  /** Inference segments that reached what an earlier segment of their window opened. */
  sameWindowReuse: number;
  /** Sessions classified this run whose `modeFor` was `"declared"`. */
  sessionsDeclared: number;
  /** Sessions classified this run whose `modeFor` was `"inferred"`. */
  sessionsInferred: number;
}

/**
 * The mode `backfill` classifies a session in. Shared with `tempad scry`, whose
 * pending count has to match what the command will actually run: a session in
 * inferred mode has no declared rerun to make, so its stale windows are not
 * pending in either.
 */
export function backfillSessionMode(
  database: Database,
  intentConfig: Pick<W5Config, "mode" | "inferenceFallback">,
  sessionId: string,
): "declared" | "inferred" {
  return intentConfig.mode === "inferred" ||
    (intentConfig.inferenceFallback && !hasAnyDeclaration(database, sessionId))
    ? "inferred"
    : "declared";
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

/** How far apart a window's first and last message may be: three throttle intervals. */
export function backfillWindowMinutes(intentConfig: W5Config): number {
  return intentConfig.throttleMinutes * 3;
}

export interface PlannedWindow {
  sessionId: string;
  /** Position within the session's own chunk list, as the failure log reports it. */
  index: number;
  startedAt: string;
  endedAt: string;
  /** The window's messages, oldest first: what the classifier is asked about. */
  messages: { ts: string; role: string; text: string }[];
  /** Last message of this session's previous window; the overlap tail's cut. */
  previousWindowEnd: string | null;
  /**
   * A re-run would skip this window: an exact `w5_windows` row (see
   * `src/intent/projections/window.ts`), or, for windows classified before
   * `window.classified` existed, a live (non-retracted) trace nested inside the
   * window's bounds. Without that fallback every such window would look
   * uncovered and be reclassified (and re-duplicated) the first time backfill
   * runs post-upgrade. Always false under `force`, and false for a stale window.
   */
  covered: boolean;
  /**
   * A declaration whose coverage reaches back over this window was recorded
   * after the window was last classified (`w5_stale_windows`, derived from
   * `quest.declared`): it ran without that quest and has to run again. Never set
   * under `force`, whose caller resets what it reruns itself. A window the
   * declaration reaches but that cannot be replaced cleanly (work on a chosen
   * quest, or a live trace not wholly inside the stale windows) is not stale:
   * it is `declined` (`resolveStaleWindows`).
   */
  stale: boolean;
  /** For a stale window, the live traces its replacement retracts. */
  replaceTraceIds: string[];
  /**
   * Why this window's stale replacement was declined (`resolveStaleWindows`), else
   * null. A declined window is neither covered nor pending: it is not replaced
   * and does not run again, in `backfill` and in `tempad scry` alike
   * (`isPendingWindow`).
   */
  declined: string | null;
}

/** A window a run would classify: not covered and not declined. The one test `backfill` and `tempad scry` share. */
export function isPendingWindow(window: Pick<PlannedWindow, "covered" | "declined">): boolean {
  return !window.covered && window.declined === null;
}

/**
 * The windows a backfill over `sessions` visits, and whether each is already
 * covered, without classifying anything. This is the one place that decides
 * both: `backfill()` runs exactly this plan (its pending windows are the
 * uncovered ones, its `windowsSkipped` the covered ones) and `tempad scry`
 * reports it, so the recommendation cannot drift from the run.
 *
 * Messages are the newest 5000 with text, oldest first, below `to` when given
 * (the same list `buildWindow` reads for a whole session), split by
 * `chunkByWindow`. Coverage reads `w5_windows` and the live `traces` once and
 * answers from memory; the per-window query it replaced scanned `traces` (no
 * `session_id` index) once per window. The projection tables are created lazily
 * by the first event that needs them, so a database that never classified
 * anything has neither: every window is then uncovered. Read-only.
 */
export function planBackfillWindows(
  database: Database,
  sessions: readonly SessionRow[],
  options: {
    windowMinutes: number;
    to?: string;
    force?: boolean;
    /** Sessions whose stale windows count; default all. Inferred-mode sessions have no declared rerun to make. */
    staleEligible?: (sessionId: string) => boolean;
  },
): PlannedWindow[] {
  const hasTable = (name: string) =>
    database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    null;
  const wanted = new Set(sessions.map((session) => session.id));
  const classified = new Map<string, string>();
  const stale = new Map<string, { from: string | null; through: string; markedAt: string }[]>();
  const traces = new Map<string, PlanTrace[]>();
  if (!options.force) {
    for (const row of (hasTable("w5_windows")
      ? database
          .query("SELECT session_id, started_at, ended_at, classified_at FROM w5_windows")
          .all()
      : []) as {
      session_id: string;
      started_at: string;
      ended_at: string;
      classified_at: string;
    }[]) {
      if (!wanted.has(row.session_id)) continue;
      const key = `${row.session_id}\u0000${row.started_at}\u0000${row.ended_at}`;
      const previous = classified.get(key);
      if (previous === undefined || previous < row.classified_at)
        classified.set(key, row.classified_at);
    }
    for (const row of (hasTable("w5_stale_windows")
      ? database
          .query("SELECT session_id, from_ts, through_ts, marked_at FROM w5_stale_windows")
          .all()
      : []) as {
      session_id: string;
      from_ts: string | null;
      through_ts: string;
      marked_at: string;
    }[]) {
      if (!wanted.has(row.session_id)) continue;
      if (options.staleEligible && !options.staleEligible(row.session_id)) continue;
      const entry = { from: row.from_ts, through: row.through_ts, markedAt: row.marked_at };
      const list = stale.get(row.session_id);
      if (list) list.push(entry);
      else stale.set(row.session_id, [entry]);
    }
    const declared = declaredQuestIds(database);
    for (const row of (hasTable("traces")
      ? database
          .query(
            `SELECT traces.id, traces.session_id, traces.started_at, traces.ended_at, traces.recorded_at,
                    stints.quest_id AS quest_id, quests.confirmed AS confirmed,
                    quests.origin_kind AS origin_kind
               FROM traces
               LEFT JOIN stints ON stints.id = traces.stint_id
               LEFT JOIN quests ON quests.id = stints.quest_id AND quests.retracted_at IS NULL
              WHERE traces.retracted_at IS NULL AND traces.session_id IS NOT NULL`,
          )
          .all()
      : []) as {
      id: string;
      session_id: string;
      started_at: string;
      ended_at: string;
      recorded_at: string;
      quest_id: string | null;
      confirmed: number | null;
      origin_kind: string | null;
    }[]) {
      if (!wanted.has(row.session_id)) continue;
      const trace: PlanTrace = {
        id: row.id,
        started_at: row.started_at,
        ended_at: row.ended_at,
        recorded_at: row.recorded_at,
        protected: isProtectedQuest(row, declared),
      };
      const list = traces.get(row.session_id);
      if (list) list.push(trace);
      else traces.set(row.session_id, [trace]);
    }
  }

  const readMessages = database.query(
    `SELECT ts, role, text_preview as text FROM claude_messages
      WHERE session_id = ? AND text_preview IS NOT NULL
      ORDER BY ts DESC LIMIT 5000`,
  );
  const planned: PlannedWindow[] = [];
  for (const session of sessions) {
    const rows = (readMessages.all(session.id) as { ts: string; role: string; text: string }[])
      .reverse()
      .filter((message) => options.to === undefined || message.ts < options.to);
    const sessionTraces = traces.get(session.id) ?? [];
    const chunks = chunkByWindow(rows, options.windowMinutes);
    const sessionWindows: PlannedWindow[] = [];
    const candidates: { stale: boolean; covered: boolean; startedAt: string; endedAt: string }[] =
      [];
    for (const [index, chunk] of chunks.entries()) {
      const startedAt = chunk[0]?.ts ?? session.ended_at;
      const endedAt = chunk.at(-1)?.ts ?? session.ended_at;
      const nested = sessionTraces.filter(
        (trace) => trace.started_at >= startedAt && trace.ended_at <= endedAt,
      );
      // When it was classified: its `w5_windows` row, else (a live run writes
      // none, and so did every window before `window.classified` existed) the
      // newest nested trace's `recorded_at`.
      const rowClassifiedAt = classified.get(`${session.id}\u0000${startedAt}\u0000${endedAt}`);
      const newest = (list: readonly PlanTrace[]) =>
        list.reduce<string | undefined>(
          (latest, trace) =>
            latest === undefined || latest < trace.recorded_at ? trace.recorded_at : latest,
          undefined,
        );
      const classifiedAt = rowClassifiedAt ?? newest(nested);
      // Whether a declaration made it stale reads any live trace that touches the
      // window, nested or crossing: a live run's trace spanning several chunks
      // leaves no `w5_windows` row and nests in none of them.
      const evidenceAt =
        rowClassifiedAt ??
        newest(
          sessionTraces.filter(
            (trace) => trace.started_at <= endedAt && trace.ended_at >= startedAt,
          ),
        );
      // A window is stale when it was classified and a declaration recorded after
      // that covers it (one never classified is simply pending). The nested-trace
      // rule does not keep it covered: those traces are what ran without the quest.
      const isStale = (stale.get(session.id) ?? []).some(
        (entry) =>
          startedAt < entry.through &&
          (entry.from === null || endedAt >= entry.from) &&
          evidenceAt !== undefined &&
          evidenceAt <= entry.markedAt,
      );
      candidates.push({
        stale: isStale,
        covered: classifiedAt !== undefined,
        startedAt,
        endedAt,
      });
      sessionWindows.push({
        sessionId: session.id,
        index,
        startedAt,
        endedAt,
        messages: chunk,
        previousWindowEnd: index > 0 ? (chunks[index - 1]?.at(-1)?.ts ?? null) : null,
        stale: false,
        replaceTraceIds: [],
        declined: null,
        covered: false,
      });
    }
    const decided = resolveStaleWindows(candidates, sessionTraces);
    for (const [position, window] of sessionWindows.entries()) {
      const decision = decided[position] as StaleDecision;
      const candidate = candidates[position] as { covered: boolean };
      window.stale = decision.stale;
      window.declined = decision.declined;
      window.replaceTraceIds = decision.traceIds;
      window.covered = !decision.stale && candidate.covered;
    }
    planned.push(...sessionWindows);
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
  let doubtsSilent = 0;
  let unknownStintIds = 0;
  let overlapDropped = 0;
  let questProposedOnMatched = 0;
  let questAttachedOnMatched = 0;
  let selectorDefaulted = 0;
  let boundsClamped = 0;
  let guessDefaulted = 0;
  let sessionNoteTruncated = 0;
  let selectorAmbiguous = 0;
  let selectorRepaired = 0;
  let sameWindowReuse = 0;
  const windowMinutes = backfillWindowMinutes(intentConfig);

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
    const mode = backfillSessionMode(database, intentConfig, sessionId);
    sessionModes.set(sessionId, mode);
    return mode;
  };

  // Windows are classified in chronological order *across* sessions, not
  // session by session. Two sessions running the same afternoon interleave in
  // real time; processing one to its end before starting the other would show a
  // window stints that, from its own point in time, had not happened yet --
  // the same future-leak `windowEnd` bounds inside a single window. Each
  // session's per-chunk `sinceTs` chain still holds, because a chunk's overlap
  // tail is derived from its own session's previous chunk, not from whatever
  // window happened to run before it.
  const planned = planBackfillWindows(database, sessions, {
    windowMinutes,
    to: options.to,
    force: options.force,
    staleEligible: (sessionId) => modeFor(sessionId) === "declared",
  });
  const pending = planned.filter(isPendingWindow);
  windowsSkipped += planned.length - pending.length;

  const plannedPerSession = new Map<string, number>();
  for (const window of planned)
    plannedPerSession.set(window.sessionId, (plannedPerSession.get(window.sessionId) ?? 0) + 1);
  const pendingPerSession = new Map<string, number>();
  for (const window of pending)
    pendingPerSession.set(window.sessionId, (pendingPerSession.get(window.sessionId) ?? 0) + 1);
  for (const session of sessions) {
    if ((plannedPerSession.get(session.id) ?? 0) > 0 && !pendingPerSession.has(session.id)) {
      sessionsSkipped += 1;
      options.log(`backfill: skipping ${session.id} (already covered)`);
    }
  }

  // One line per declined group: the session, the range it spans and why no
  // window of it is replaced or run again.
  const declinedBySession = new Map<string, PlannedWindow[]>();
  for (const window of planned) {
    if (window.declined === null) continue;
    const list = declinedBySession.get(window.sessionId);
    if (list) list.push(window);
    else declinedBySession.set(window.sessionId, [window]);
  }
  for (const [sessionId, windows] of declinedBySession) {
    const first = windows[0] as PlannedWindow;
    const last = windows.at(-1) as PlannedWindow;
    options.log(
      `backfill: declined stale replacement for ${sessionId} windows ${first.index}-${last.index} (${first.startedAt} to ${last.endedAt}): ${first.declined}; nothing retracted, nothing rerun`,
    );
  }

  // Decide every session's mode now, before any window is applied.
  for (const session of sessions) modeFor(session.id);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));

  pending.sort((left, right) =>
    left.startedAt === right.startedAt
      ? left.sessionId.localeCompare(right.sessionId)
      : left.startedAt < right.startedAt
        ? -1
        : 1,
  );

  const sessionSuccesses = new Map<string, number>();
  const sessionPendingCounts = new Map<string, number>();
  for (const window of pending) {
    sessionPendingCounts.set(
      window.sessionId,
      (sessionPendingCounts.get(window.sessionId) ?? 0) + 1,
    );
  }

  // A declaration that now covers a window arrived after the window was
  // classified: what that pass recorded is replaced, not added to. Every stale
  // window is cleared before any is classified, not one by one as the loop gets
  // to it: a stint of a later stale window that is still live would be offered
  // to (and reused by) an earlier one, and carry the declared quest back onto
  // work that is about to be replaced.
  for (const window of pending) {
    if (!window.stale) continue;
    const replaced = replaceStaleWindow(database, { traceIds: window.replaceTraceIds });
    options.log(
      `backfill: replaced ${window.sessionId} window ${window.index} (${window.startedAt} to ${window.endedAt}): a declaration now covers it; retracted traces=${replaced.traces} stints=${replaced.stints} quests=${replaced.quests}, kept ${replaced.kept} on chosen quests`,
    );
  }

  for (const {
    sessionId,
    messages,
    index,
    startedAt,
    endedAt,
    previousWindowEnd: previousChunkEnd,
  } of pending) {
    const session = sessionsById.get(sessionId) as SessionRow;
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
    const sessionKind = effectiveSessionKind(database, session.id)?.kind;
    const chunkWindow = {
      ...buildWindow(database, {
        sessionId: session.id,
        mode: modeFor(session.id),
        ...(sessionKind === undefined ? {} : { sessionKind }),
        sinceTs: previousChunkEnd,
        maxMessages: 5000,
        memoryHours: intentConfig.memoryHours,
        memoryStints: intentConfig.memoryStints,
        memoryQuests: intentConfig.memoryQuests,
        overlapMessages: intentConfig.overlapMessages,
        windowEnd: endedAt,
      }),
      messages,
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
      doubtsSilent += applied.doubtsSilent;
      unknownStintIds += applied.unknownStintIds;
      overlapDropped += result.overlapDropped ?? 0;
      questProposedOnMatched += applied.questProposedOnMatched;
      questAttachedOnMatched += applied.questAttachedOnMatched;
      selectorDefaulted += result.selectorDefaulted ?? 0;
      boundsClamped += result.boundsClamped ?? 0;
      guessDefaulted += result.guessDefaulted ?? 0;
      sessionNoteTruncated += result.sessionNoteTruncated ?? 0;
      selectorAmbiguous += result.selectorAmbiguous ?? 0;
      selectorRepaired += applied.selectorRepaired;
      sameWindowReuse += applied.sameWindowReuse;
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
    doubtsSilent,
    unknownStintIds,
    overlapDropped,
    questProposedOnMatched,
    questAttachedOnMatched,
    selectorDefaulted,
    boundsClamped,
    guessDefaulted,
    sessionNoteTruncated,
    selectorAmbiguous,
    selectorRepaired,
    sameWindowReuse,
    sessionsDeclared,
    sessionsInferred,
  };
}
