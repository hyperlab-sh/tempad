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

/**
 * Which candidate windows of one session can be replaced, and which live traces
 * the replacement retracts.
 *
 * A trace the live runner wrote can span several backfill chunks, so clearing
 * one window by its fully nested traces would leave the crossing trace alive next
 * to the rerun's new ones: the same stretch counted twice. Windows linked by a
 * crossing trace therefore form one group, replaced together or not at all. A
 * group is replaced only when:
 * - every window in it is stale or not yet classified (a covered window the
 *   declaration does not reach would be left holding half of a retracted trace);
 * - none of its traces, nested or crossing, carries a protected quest (a rerun
 *   would classify the whole window again on top of work somebody chose);
 * - each trace's first and last instants fall inside a window of the group (the
 *   rerun can only re-cover time that has messages in it).
 * A group that fails any of these keeps its windows exactly as they were
 * (`stale: false`; a covered window stays covered). The traces retracted are
 * those overlapping a window of the group, so scope never grows past the
 * session's stale windows.
 */
export function resolveStaleWindows(
  windows: readonly StaleCandidate[],
  traces: readonly PlanTrace[],
): { stale: boolean; traceIds: string[] }[] {
  const result = windows.map(() => ({ stale: false, traceIds: [] as string[] }));
  if (!windows.some((window) => window.stale)) return result;

  const parent = windows.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] as number;
    let node = index;
    while (parent[node] !== root) {
      const next = parent[node] as number;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    parent[find(left)] = find(right);
  };

  const overlapping = traces.map((trace) =>
    windows.flatMap((window, index) =>
      trace.started_at <= window.endedAt && trace.ended_at >= window.startedAt ? [index] : [],
    ),
  );
  const endpointsCovered = traces.map(
    (trace) =>
      windows.some((w) => trace.started_at >= w.startedAt && trace.started_at <= w.endedAt) &&
      windows.some((w) => trace.ended_at >= w.startedAt && trace.ended_at <= w.endedAt),
  );
  for (const indexes of overlapping) {
    for (const index of indexes.slice(1)) union(indexes[0] as number, index);
  }

  const groups = new Map<number, number[]>();
  for (const [index] of windows.entries()) {
    const root = find(index);
    const list = groups.get(root);
    if (list) list.push(index);
    else groups.set(root, [index]);
  }
  for (const [root, members] of groups) {
    if (!members.some((index) => windows[index]?.stale)) continue;
    const groupTraces = traces.flatMap((_trace, traceIndex) =>
      overlapping[traceIndex]?.some((index) => find(index) === root) ? [traceIndex] : [],
    );
    const blocked =
      members.some((index) => {
        const window = windows[index] as StaleCandidate;
        return window.covered && !window.stale;
      }) ||
      groupTraces.some(
        (traceIndex) =>
          (traces[traceIndex] as PlanTrace).protected || !endpointsCovered[traceIndex],
      );
    if (blocked) continue;
    for (const index of members) {
      const entry = result[index] as { stale: boolean; traceIds: string[] };
      entry.stale = windows[index]?.stale === true;
      entry.traceIds = groupTraces
        .filter((traceIndex) => overlapping[traceIndex]?.includes(index))
        .map((traceIndex) => (traces[traceIndex] as PlanTrace).id);
    }
  }
  return result;
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
