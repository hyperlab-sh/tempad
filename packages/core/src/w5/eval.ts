import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { HomeConfig } from "../config/env";
import { openDatabase } from "../db/database";
import { defaultIntentConfig } from "../intent/config";
import { declareQuest } from "../intent/declarations";
import { currentHeroId } from "../intent/identity";
import { newUlid } from "../intent/ids";
import { applyIncremental } from "../intent/projections";
import { registerAllProjections } from "../intent/projections/register";
import { EventStore } from "../intent/store";
import { localDayBoundsUtc } from "../report/markdown.ts";
import { backfill } from "./backfill";
import type { Classifier } from "./classifier";

registerAllProjections();

export class InvalidEvalRangeError extends Error {}
export class InvalidDeclareFileError extends Error {}

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A bare `--from`/`--to` date (`"2026-09-02"`, no time component) resolves to
 * that day in the configured `TZ` -- the same local day reports use, via
 * `localDayBoundsUtc` -- not to UTC midnight. Comparing a bare date as TEXT
 * against full ISO timestamps with `<=` would also silently exclude the
 * whole `to` day, since any timestamp on that day sorts lexicographically
 * after the bare date string; normalizing once here turns a bare `from` into
 * that local day's UTC start and a bare `to` into the *next local day's* UTC
 * start, so every caller can compare the upper bound with a plain `<` and
 * get an inclusive `to` day. A full ISO input is trusted as given and used
 * as an exclusive upper bound, matching how `from` is always inclusive.
 */
export interface EvalRange {
  from: string;
  to: string;
}

function normalizeEvalRange(from: string, to: string, timeZone: string): EvalRange {
  const normalizedFrom = BARE_DATE.test(from) ? localDayBoundsUtc(from, timeZone).start : from;
  const normalizedTo = BARE_DATE.test(to) ? localDayBoundsUtc(to, timeZone).end : to;
  return { from: normalizedFrom, to: normalizedTo };
}

export function validateEvalRange(from: string, to: string, timeZone = "UTC"): EvalRange {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs)) {
    throw new InvalidEvalRangeError(`--from is not a valid date: ${from}`);
  }
  if (Number.isNaN(toMs)) {
    throw new InvalidEvalRangeError(`--to is not a valid date: ${to}`);
  }
  if (fromMs > toMs) {
    throw new InvalidEvalRangeError(`--from (${from}) must be on or before --to (${to})`);
  }
  return normalizeEvalRange(from, to, timeZone);
}

function minimalConfig(scratchDir: string): HomeConfig {
  return { home: scratchDir };
}

export interface EvalOptions {
  from: string;
  to: string;
  sourceDbPath: string;
  scratchDir: string;
  now: string;
  classifier: Classifier;
  log: (line: string) => void;
  declareFile?: string;
  /** IANA zone bare `from`/`to` dates resolve in. Defaults to UTC. */
  timeZone?: string;
  /** Push sync on: rerun only this host's sessions (passed to `backfill`). */
  hostSlug?: string;
}

interface DeclareFileEntry {
  session_id: string;
  at: string;
  quest?: string;
  quest_ref?: string;
  new?: {
    title: string;
    outcome: string;
    commitment: "promised" | "personal" | "exploratory";
    project?: string;
    plan?: string[];
  };
  new_ref?: string;
  scope?: "session" | "subagent";
  parent_session_id?: string;
  declared_by?: "agent" | "hero";
  plan?: string[];
}

export interface DeclareFileResult {
  declarationsSkipped: number;
}

/**
 * Reads a `--declare` file (TOML or JSON, chosen by extension) and applies
 * each entry as a `quest.declared` (plus `quest.created` when `new` is
 * given) event against the copy -- so history can be evaluated in declared
 * mode without the source database ever holding hand-authored declarations.
 *
 * `new_ref`/`quest_ref` let one file create a quest in one entry and reuse
 * it in a later entry, resolved in file order -- an unknown ref is a file
 * error (`InvalidDeclareFileError`), same as a missing/malformed file.
 *
 * A `session_id` absent from the copy's `claude_sessions` still appends a
 * `quest.declared` event (declarations are events, not FK-checked), but it
 * can never resolve to any trace/window, so it is logged and counted in
 * `declarationsSkipped` rather than silently accepted.
 */
async function applyDeclareFile(
  database: Database,
  declareFilePath: string,
  log: (line: string) => void,
): Promise<DeclareFileResult> {
  let text: string;
  try {
    text = await Bun.file(declareFilePath).text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidDeclareFileError(`--declare file could not be read: ${message}`);
  }

  let entries: DeclareFileEntry[];
  try {
    const parsed = declareFilePath.endsWith(".toml") ? Bun.TOML.parse(text) : JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new InvalidDeclareFileError("--declare file must contain a JSON/TOML array");
    }
    entries = parsed as DeclareFileEntry[];
  } catch (error) {
    if (error instanceof InvalidDeclareFileError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidDeclareFileError(`--declare file is not valid JSON/TOML: ${message}`);
  }

  const store = new EventStore(database);

  const existingHero = currentHeroId(database);
  let hero = existingHero ? { id: existingHero } : null;
  if (!hero) {
    const heroId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: heroId,
        payload: { name: "eval" },
      }),
    );
    hero = { id: heroId };
  }

  const questIdByRef = new Map<string, string>();
  let declarationsSkipped = 0;

  entries.forEach((entry, index) => {
    const selectorCount = [entry.quest, entry.quest_ref, entry.new].filter(
      (value) => value !== undefined,
    ).length;
    if (selectorCount !== 1) {
      throw new InvalidDeclareFileError(
        `--declare file entry ${index}: exactly one of quest, quest_ref, or new is required`,
      );
    }
    if (entry.new_ref !== undefined && entry.new === undefined) {
      throw new InvalidDeclareFileError(
        `--declare file entry ${index}: new_ref is only allowed alongside new`,
      );
    }

    let questId = entry.quest;
    if (entry.quest_ref !== undefined) {
      const resolved = questIdByRef.get(entry.quest_ref);
      if (resolved === undefined) {
        throw new InvalidDeclareFileError(
          `--declare file entry ${index}: unknown quest_ref "${entry.quest_ref}"`,
        );
      }
      questId = resolved;
    }

    const session = database
      .query("SELECT 1 FROM claude_sessions WHERE id = ?")
      .get(entry.session_id);
    if (!session) {
      log(
        `w5 eval: --declare entry for session "${entry.session_id}" has no matching session in the copy, declaration recorded but will not resolve to any trace`,
      );
      declarationsSkipped += 1;
    }

    const result = declareQuest(store, database, {
      sessionId: entry.session_id,
      parentSessionId: entry.parent_session_id,
      questId,
      newQuest: entry.new
        ? {
            title: entry.new.title,
            outcome: entry.new.outcome,
            commitment: entry.new.commitment,
            project: entry.new.project,
          }
        : undefined,
      plan: entry.new?.plan ?? entry.plan ?? [],
      scope: entry.scope ?? "session",
      declaredBy: entry.declared_by ?? "hero",
      at: entry.at,
      heroId: hero.id,
    });

    if (entry.new_ref !== undefined) {
      if (!result.created) {
        throw new InvalidDeclareFileError(
          `--declare file entry ${index}: new_ref "${entry.new_ref}" was not bound because no quest was created`,
        );
      }
      questIdByRef.set(entry.new_ref, result.questId);
    }
  });

  return { declarationsSkipped };
}

export interface EvalSampleStint {
  what: string;
  why: string;
  questTitle: string | null;
  durationMinutes: number | null;
  sessionTitle: string | null;
}

export interface EvalMetrics {
  copiedDbPath: string;
  resetTraces: number;
  resetStints: number;
  resetQuests: number;
  traces: number;
  stints: number;
  ratio: number;
  medianStintDurationMinutes: number;
  continuesLinks: number;
  doubts: number;
  doubtsAnswered: number;
  /**
   * Traces with a non-null `doubt` in range -- the same fact `tempad review`
   * lists, counted here so the run summary is auditable even when asking is
   * disabled and no question was ever created for it.
   */
  doubtsRecorded: number;
  tracesUnattributed: number;
  declarationsSkipped: number;
  unknownStintIds: number;
  overlapDropped: number;
  questProposedOnMatched: number;
  selectorDefaulted: number;
  selectorAmbiguous: number;
  sessionsDeclared: number;
  sessionsInferred: number;
  stintsDismissed: number;
  planStintsHit: number;
  stintsNew: number;
  sample: EvalSampleStint[];
}

export interface EvalResetResult {
  traces: number;
  stints: number;
  quests: number;
}

const RESET_REASON = "eval reset";

/**
 * Retracts, on the copy only, every old-cohort row the eval range would
 * otherwise mix into the rerun's metrics: live traces started in
 * `[from, to]`, then stints left with no live trace, then unconfirmed
 * quests left with no live stint -- mirroring `dedupe.ts`'s cascade but
 * selecting by date range instead of duplicate grouping. Also clears
 * `w5_runs.session_note` and deletes `w5_windows` rows for every touched
 * session, since the rerun's `force` flag bypasses `w5_windows` coverage
 * but the copy is otherwise left inconsistent with what the rerun records.
 */
function resetRange(database: Database, from: string, to: string): EvalResetResult {
  const store = new EventStore(database);

  const traceRows = database
    .query(
      `SELECT id, stint_id, session_id FROM traces
       WHERE retracted_at IS NULL AND started_at >= ? AND started_at < ?`,
    )
    .all(from, to) as { id: string; stint_id: string; session_id: string | null }[];

  const sessionIds = new Set(
    traceRows.map((row) => row.session_id).filter((id): id is string => id !== null),
  );

  const affectedStintIds = new Set(traceRows.map((row) => row.stint_id));
  const retractedTraceIds = new Set(traceRows.map((row) => row.id));

  const result = { traces: 0, stints: 0, quests: 0 };

  const run = database.transaction(() => {
    for (const trace of traceRows) {
      applyIncremental(
        database,
        store.append({
          actor: "backfill",
          kind: "retracted",
          subject: trace.id,
          payload: { retracts: trace.id, reason: RESET_REASON },
        }),
      );
    }
    result.traces = traceRows.length;

    const stintsToRetract: string[] = [];
    for (const stintId of affectedStintIds) {
      const liveTraces = database
        .query("SELECT id FROM traces WHERE stint_id = ? AND retracted_at IS NULL")
        .all(stintId) as { id: string }[];
      const hasLiveTrace = liveTraces.some((trace) => !retractedTraceIds.has(trace.id));
      if (!hasLiveTrace) stintsToRetract.push(stintId);
    }
    for (const stintId of stintsToRetract) {
      applyIncremental(
        database,
        store.append({
          actor: "backfill",
          kind: "retracted",
          subject: stintId,
          payload: { retracts: stintId, reason: RESET_REASON },
        }),
      );
    }
    result.stints = stintsToRetract.length;

    const affectedQuestIds = new Set(
      stintsToRetract
        .map(
          (stintId) =>
            (
              database.query("SELECT quest_id FROM stints WHERE id = ?").get(stintId) as {
                quest_id: string | null;
              } | null
            )?.quest_id ?? null,
        )
        .filter((id): id is string => id !== null),
    );
    const retractedStintIds = new Set(stintsToRetract);
    const questsToRetract: string[] = [];
    for (const questId of affectedQuestIds) {
      const quest = database
        .query("SELECT confirmed FROM quests WHERE id = ? AND retracted_at IS NULL")
        .get(questId) as { confirmed: number } | null;
      if (!quest || quest.confirmed === 1) continue;
      const liveStints = database
        .query("SELECT id FROM stints WHERE quest_id = ? AND retracted_at IS NULL")
        .all(questId) as { id: string }[];
      const hasLiveStint = liveStints.some((stint) => !retractedStintIds.has(stint.id));
      if (!hasLiveStint) questsToRetract.push(questId);
    }
    for (const questId of questsToRetract) {
      applyIncremental(
        database,
        store.append({
          actor: "backfill",
          kind: "retracted",
          subject: questId,
          payload: { retracts: questId, reason: RESET_REASON },
        }),
      );
    }
    result.quests = questsToRetract.length;

    for (const sessionId of sessionIds) {
      database.query("UPDATE w5_runs SET session_note = NULL WHERE session_id = ?").run(sessionId);
      database.query("DELETE FROM w5_windows WHERE session_id = ?").run(sessionId);
    }
  });
  run();

  return {
    traces: result.traces,
    stints: result.stints,
    quests: result.quests,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }
  return sorted[mid] as number;
}

function filenameSafe(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

/**
 * Copies via SQLite's own `VACUUM INTO`, not a file-level copy: `openDatabase`
 * runs every database (including the real `tempad.db`) in WAL mode, so a
 * plain file copy can silently miss committed transactions still sitting in
 * the `-wal` sidecar. `VACUUM INTO` reads through the live connection and
 * always sees the fully committed state, with no separate sidecar to miss.
 */
function copyDatabase(sourceDbPath: string, destinationPath: string): void {
  const source = new Database(sourceDbPath, { readonly: true });
  try {
    source.exec("VACUUM INTO ?", [destinationPath]);
  } finally {
    source.close();
  }
}

export async function runEval(options: EvalOptions): Promise<EvalMetrics> {
  const range = validateEvalRange(options.from, options.to, options.timeZone);

  const copiedDbPath = join(options.scratchDir, `eval-${filenameSafe(options.now)}.db`);
  copyDatabase(options.sourceDbPath, copiedDbPath);

  const database = openDatabase(copiedDbPath);
  const intentConfig = defaultIntentConfig();

  let declarationsSkipped = 0;
  if (options.declareFile) {
    const declareResult = await applyDeclareFile(database, options.declareFile, options.log);
    declarationsSkipped = declareResult.declarationsSkipped;
  }

  const resetResult = resetRange(database, range.from, range.to);
  options.log(
    `eval: reset traces=${resetResult.traces} stints=${resetResult.stints} quests=${resetResult.quests}`,
  );

  const backfillResult = await backfill(
    database,
    minimalConfig(options.scratchDir),
    intentConfig.w5,
    options.classifier,
    {
      days: 0,
      now: options.to,
      log: options.log,
      force: true,
      from: range.from,
      to: range.to,
      ...(options.hostSlug !== undefined ? { hostSlug: options.hostSlug } : {}),
    },
  );

  const traceCount = database
    .query(
      "SELECT COUNT(*) as count FROM traces WHERE retracted_at IS NULL AND started_at >= ? AND started_at < ?",
    )
    .get(range.from, range.to) as { count: number };
  const stintCount = database
    .query(
      "SELECT COUNT(*) as count FROM stints WHERE retracted_at IS NULL AND dismissed_at IS NULL AND opened_at >= ? AND opened_at < ?",
    )
    .get(range.from, range.to) as { count: number };
  const continuesCount = database
    .query(
      "SELECT COUNT(*) as count FROM stints WHERE continues IS NOT NULL AND retracted_at IS NULL AND opened_at >= ? AND opened_at < ?",
    )
    .get(range.from, range.to) as { count: number };
  const doubtsAnsweredCount = database
    .query(
      `SELECT COUNT(*) as count FROM questions qu
       JOIN traces t ON t.id = qu.trace_id
       WHERE qu.kind IN ('belongs', 'declare') AND qu.state IN ('resolved_by_context', 'answered')
         AND t.retracted_at IS NULL AND t.started_at >= ? AND t.started_at < ?`,
    )
    .get(range.from, range.to) as { count: number };
  const doubtsRecordedCount = database
    .query(
      `SELECT COUNT(*) as count FROM traces t
       JOIN stints s ON s.id = t.stint_id
       WHERE t.doubt IS NOT NULL AND t.retracted_at IS NULL
         AND s.dismissed_at IS NULL AND s.retracted_at IS NULL
         AND t.started_at >= ? AND t.started_at < ?`,
    )
    .get(range.from, range.to) as { count: number };
  const tracesUnattributedCount = database
    .query(
      `SELECT COUNT(*) as count FROM traces t
       JOIN stints a ON a.id = t.stint_id
       WHERE t.retracted_at IS NULL AND a.quest_id IS NULL
         AND t.started_at >= ? AND t.started_at < ?`,
    )
    .get(range.from, range.to) as { count: number };
  const stintsDismissedCount = database
    .query(
      `SELECT COUNT(*) as count FROM stints
       WHERE dismissed_at IS NOT NULL AND opened_at >= ? AND opened_at < ?`,
    )
    .get(range.from, range.to) as { count: number };
  const planStintsHitCount = database
    .query(
      `SELECT COUNT(*) as count FROM traces t
       JOIN stints s ON s.id = t.stint_id
       WHERE t.retracted_at IS NULL AND s.plan_index IS NOT NULL
         AND t.started_at >= ? AND t.started_at < ?`,
    )
    .get(range.from, range.to) as { count: number };
  const stintsNewCount = database
    .query(
      `SELECT COUNT(*) as count FROM stints s
       WHERE s.retracted_at IS NULL AND s.plan_index IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM stints origin
            WHERE origin.id = s.continues
              AND (origin.dismissed_at IS NOT NULL OR origin.plan_index IS NOT NULL)
         )
         AND s.opened_at >= ? AND s.opened_at < ?`,
    )
    .get(range.from, range.to) as { count: number };

  const durationRows = database
    .query(
      "SELECT opened_at as openedAt, closed_at as closedAt FROM stints WHERE closed_at IS NOT NULL AND retracted_at IS NULL AND opened_at >= ? AND opened_at < ?",
    )
    .all(range.from, range.to) as { openedAt: string; closedAt: string }[];
  const durationsMinutes = durationRows.map(
    (row) => (Date.parse(row.closedAt) - Date.parse(row.openedAt)) / 60_000,
  );

  const sampleRows = database
    .query(
      `SELECT stints.outcome as outcome,
              quests.title as questTitle,
              stints.opened_at as openedAt, stints.closed_at as closedAt,
              (SELECT traces.what FROM traces
                 WHERE traces.stint_id = stints.id AND traces.retracted_at IS NULL
                 ORDER BY traces.started_at ASC LIMIT 1) as what,
              (SELECT traces.why FROM traces
                 WHERE traces.stint_id = stints.id AND traces.retracted_at IS NULL
                 ORDER BY traces.started_at ASC LIMIT 1) as why,
              (SELECT claude_sessions.title FROM traces
                 JOIN claude_sessions ON claude_sessions.id = traces.session_id
                 WHERE traces.stint_id = stints.id AND traces.retracted_at IS NULL
                 ORDER BY traces.started_at ASC LIMIT 1) as sessionTitle
         FROM stints
         LEFT JOIN quests ON quests.id = stints.quest_id
        WHERE stints.retracted_at IS NULL
          AND stints.opened_at >= ? AND stints.opened_at < ?
        ORDER BY RANDOM() LIMIT 20`,
    )
    .all(range.from, range.to) as {
    outcome: string;
    questTitle: string | null;
    openedAt: string;
    closedAt: string | null;
    what: string | null;
    why: string | null;
    sessionTitle: string | null;
  }[];

  const sample: EvalSampleStint[] = sampleRows.map((row) => ({
    what: row.what ?? row.outcome,
    why: row.why ?? "",
    questTitle: row.questTitle,
    durationMinutes: row.closedAt
      ? (Date.parse(row.closedAt) - Date.parse(row.openedAt)) / 60_000
      : null,
    sessionTitle: row.sessionTitle,
  }));

  database.close();

  return {
    copiedDbPath,
    resetTraces: resetResult.traces,
    resetStints: resetResult.stints,
    resetQuests: resetResult.quests,
    traces: traceCount.count,
    stints: stintCount.count,
    ratio: traceCount.count === 0 ? 0 : stintCount.count / traceCount.count,
    medianStintDurationMinutes: median(durationsMinutes),
    continuesLinks: continuesCount.count,
    doubts: backfillResult.doubts,
    doubtsAnswered: doubtsAnsweredCount.count,
    doubtsRecorded: doubtsRecordedCount.count,
    tracesUnattributed: tracesUnattributedCount.count,
    declarationsSkipped,
    unknownStintIds: backfillResult.unknownStintIds,
    overlapDropped: backfillResult.overlapDropped,
    questProposedOnMatched: backfillResult.questProposedOnMatched,
    selectorDefaulted: backfillResult.selectorDefaulted,
    selectorAmbiguous: backfillResult.selectorAmbiguous,
    sessionsDeclared: backfillResult.sessionsDeclared,
    sessionsInferred: backfillResult.sessionsInferred,
    stintsDismissed: stintsDismissedCount.count,
    planStintsHit: planStintsHitCount.count,
    stintsNew: stintsNewCount.count,
    sample,
  };
}
