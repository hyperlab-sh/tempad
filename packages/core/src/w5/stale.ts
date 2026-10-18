import type { Database } from "bun:sqlite";
import { applyReset, planReset, type ResetTrace } from "./reset";

/**
 * Every quest some `quest.declared` event names, whichever session declared it
 * and whether or not it was later ended. Naming an existing quest with
 * `quest declare --quest` changes neither its `origin_kind` nor `confirmed`, so
 * the declaration itself is the only record that somebody chose it.
 */
export function declaredQuestIds(database: Database): Set<string> {
  const rows = database
    .query(
      `SELECT DISTINCT json_extract(payload, '$.quest_id') AS id FROM events
        WHERE kind = 'quest.declared'`,
    )
    .all() as { id: string | null }[];
  return new Set(rows.flatMap((row) => (row.id === null ? [] : [row.id])));
}

/**
 * A stint whose quest was chosen, not inferred: created as declared, confirmed
 * by a person, or named by a declaration. A stale window never replaces what
 * hangs on one.
 */
export function isProtectedQuest(
  quest: { quest_id: string | null; confirmed: number | null; origin_kind: string | null },
  declared: ReadonlySet<string>,
): boolean {
  if (quest.quest_id === null) return false;
  return quest.confirmed === 1 || quest.origin_kind === "declared" || declared.has(quest.quest_id);
}

/** A live trace as the planner reads it. */
export interface PlanTrace {
  id: string;
  started_at: string;
  ended_at: string;
  recorded_at: string;
  /** Its stint carries a quest `isProtectedQuest` says to keep. */
  protected: boolean;
}

/** One planned window, before the stale decision. */
export interface StaleCandidate {
  startedAt: string;
  endedAt: string;
  /** A declaration recorded after the window was classified covers it. */
  stale: boolean;
  /** A rerun would otherwise skip it. */
  covered: boolean;
}

/** What the planner decided for one window. */
export interface StaleDecision {
  /** The window is replaced: its `traceIds` are retracted and it runs again. */
  stale: boolean;
  /** Why the window's group was declined, else null. A declined window never runs again. */
  declined: string | null;
  traceIds: string[];
}

/**
 * Which windows of one session a declaration replaces, decided once over the
 * union of every stale window of the session in this run.
 *
 * The rule: the replacement proceeds only when every live trace that overlaps
 * the union lies entirely inside it and none of them is protected (carries a
 * declared or confirmed quest). Otherwise the whole group is declined: nothing
 * is retracted, no window of the group runs again, and every member is marked
 * declined, which neither `backfill` nor `tempad scry` counts as pending. The
 * reason names the first offending trace (`protected trace <id>`,
 * `crossing trace <id>`, `out of bounds trace <id>`).
 *
 * Why inside the union and not merely at its endpoints: a rerun can only
 * re-cover the time that has messages in a window, so a trace that crosses two
 * chunks, or runs past one, would either survive next to its replacement (the
 * stretch counted twice) or be retracted with the part between the chunks lost.
 * The check reads trace bounds only, never `w5_windows` or a classification
 * time, so a live run's trace (which leaves neither) is caught the same way.
 *
 * Members of a declined group: the stale windows, plus every uncovered window
 * that overlaps a trace overlapping the union (a rerun of it would add a second
 * copy of what that trace already holds).
 */
export function resolveStaleWindows(
  windows: readonly StaleCandidate[],
  traces: readonly PlanTrace[],
): StaleDecision[] {
  const decisions = windows.map(() => ({
    stale: false,
    declined: null as string | null,
    traceIds: [] as string[],
  }));
  const members = windows.flatMap((window, index) => (window.stale ? [index] : []));
  if (members.length === 0) return decisions;

  const touches = (trace: PlanTrace, window: StaleCandidate) =>
    trace.started_at <= window.endedAt && trace.ended_at >= window.startedAt;
  const union: { from: string; through: string }[] = [];
  for (const index of [...members].sort((a, b) =>
    (windows[a] as StaleCandidate).startedAt < (windows[b] as StaleCandidate).startedAt ? -1 : 1,
  )) {
    const window = windows[index] as StaleCandidate;
    const last = union.at(-1);
    if (last && window.startedAt <= last.through) {
      if (window.endedAt > last.through) last.through = window.endedAt;
    } else union.push({ from: window.startedAt, through: window.endedAt });
  }

  const overlapping = traces
    .filter((trace) =>
      union.some((span) => trace.started_at <= span.through && trace.ended_at >= span.from),
    )
    .sort((a, b) =>
      a.started_at === b.started_at
        ? a.id.localeCompare(b.id)
        : a.started_at < b.started_at
          ? -1
          : 1,
    );
  const protectedTrace = overlapping.find((trace) => trace.protected);
  const escaping = overlapping.find(
    (trace) =>
      !union.some((span) => trace.started_at >= span.from && trace.ended_at <= span.through),
  );
  let reason: string | null = null;
  if (protectedTrace) reason = `protected trace ${protectedTrace.id}`;
  else if (escaping) {
    const crossed = members.filter((index) => touches(escaping, windows[index] as StaleCandidate));
    reason = `${crossed.length > 1 ? "crossing" : "out of bounds"} trace ${escaping.id}`;
  }

  if (reason === null) {
    for (const index of members) {
      const entry = decisions[index] as StaleDecision;
      entry.stale = true;
      entry.traceIds = overlapping
        .filter((trace) => touches(trace, windows[index] as StaleCandidate))
        .map((trace) => trace.id);
    }
    return decisions;
  }
  for (const [index, window] of windows.entries()) {
    const overlapsGroupTrace = overlapping.some((trace) => touches(trace, window));
    if (window.stale || (!window.covered && overlapsGroupTrace))
      (decisions[index] as StaleDecision).declined = reason;
  }
  return decisions;
}

export interface StaleWindowReplacement {
  traces: number;
  stints: number;
  quests: number;
  /** Traces left alone because their stint carries a declared or confirmed quest. */
  kept: number;
}

/**
 * Clears what an earlier pass recorded for one stale window, so classifying it
 * again in declared mode replaces that work instead of adding to it (traces sum
 * to minutes, so two passes over one stretch would count it twice).
 *
 * This is not a bulk retract. It runs only for a window `planBackfillWindows`
 * marked stale, which only a declaration whose coverage reaches back over it
 * (`w5_stale_windows`) can cause; the traces are the ones the planner chose for
 * that window (`resolveStaleWindows`: those overlapping it, and the group it is
 * linked to by crossing traces), and it goes through `planReset`/`applyReset`
 * unchanged, so the same cascade and the same protections hold: a stint that
 * keeps another live trace stays, and a confirmed quest is never retracted. The
 * planner already declined any window with work on a protected quest; this
 * re-checks (the log may have moved since the plan) and, as a last guard, never
 * retracts a declared quest.
 *
 * `applyReset` also clears the session's note and every `w5_windows` row of the
 * session, which suits `w5 eval`'s throwaway copy but not a real database (the
 * other windows are still classified), so those two are left out of the plan.
 */
export function replaceStaleWindow(
  database: Database,
  window: { traceIds: readonly string[] },
): StaleWindowReplacement {
  if (window.traceIds.length === 0) return { traces: 0, stints: 0, quests: 0, kept: 0 };
  const rows = database
    .query(
      `SELECT traces.id, traces.stint_id, traces.session_id,
              stints.quest_id AS quest_id, quests.confirmed AS confirmed,
              quests.origin_kind AS origin_kind
         FROM traces
         JOIN stints ON stints.id = traces.stint_id
         LEFT JOIN quests ON quests.id = stints.quest_id AND quests.retracted_at IS NULL
        WHERE traces.id IN (SELECT value FROM json_each(?)) AND traces.retracted_at IS NULL
        ORDER BY traces.started_at ASC, traces.id ASC`,
    )
    .all(JSON.stringify(window.traceIds)) as (ResetTrace & {
    quest_id: string | null;
    confirmed: number | null;
    origin_kind: string | null;
  })[];

  const declared = declaredQuestIds(database);
  const replaceable: ResetTrace[] = [];
  let kept = 0;
  for (const row of rows) {
    if (isProtectedQuest(row, declared)) {
      kept += 1;
      continue;
    }
    replaceable.push({ id: row.id, stint_id: row.stint_id, session_id: row.session_id });
  }

  if (replaceable.length === 0) return { traces: 0, stints: 0, quests: 0, kept };
  const plan = planReset(database, replaceable);
  plan.sessionIds = [];
  plan.questIds = plan.questIds.filter((id) => !declared.has(id));
  const result = applyReset(database, plan, { reason: "declaration covers window" });
  return { traces: result.traces, stints: result.stints, quests: result.quests, kept };
}
