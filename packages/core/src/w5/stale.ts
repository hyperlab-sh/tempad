import type { Database } from "bun:sqlite";
import { applyReset, planReset, type ResetTrace } from "./reset";

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
 * (`w5_stale_windows`) can cause; it takes one session and that window's own
 * bounds, and goes through `planReset`/`applyReset` unchanged, so the same
 * cascade and the same protections hold: a stint that keeps another live trace
 * stays, and a confirmed quest is never retracted. On top of that, a stint that
 * already carries a declared quest or a confirmed one is skipped here (its
 * traces are not selected): somebody or something already decided what it
 * belongs to. The traces selected are the ones nested in the window, the rule
 * the planner's own coverage uses.
 *
 * `applyReset` also clears the session's note and every `w5_windows` row of the
 * session, which suits `w5 eval`'s throwaway copy but not a real database (the
 * other windows are still classified), so those two are left out of the plan.
 */
export function replaceStaleWindow(
  database: Database,
  window: { sessionId: string; startedAt: string; endedAt: string },
): StaleWindowReplacement {
  const rows = database
    .query(
      `SELECT traces.id, traces.stint_id, traces.session_id,
              stints.quest_id AS quest_id, quests.confirmed AS confirmed,
              quests.origin_kind AS origin_kind
         FROM traces
         JOIN stints ON stints.id = traces.stint_id
         LEFT JOIN quests ON quests.id = stints.quest_id AND quests.retracted_at IS NULL
        WHERE traces.session_id = ? AND traces.retracted_at IS NULL
          AND traces.started_at >= ? AND traces.ended_at <= ?
        ORDER BY traces.started_at ASC, traces.id ASC`,
    )
    .all(window.sessionId, window.startedAt, window.endedAt) as (ResetTrace & {
    quest_id: string | null;
    confirmed: number | null;
    origin_kind: string | null;
  })[];

  const replaceable: ResetTrace[] = [];
  let kept = 0;
  for (const row of rows) {
    const protectedStint = row.confirmed === 1 || row.origin_kind === "declared";
    if (protectedStint) {
      kept += 1;
      continue;
    }
    replaceable.push({ id: row.id, stint_id: row.stint_id, session_id: row.session_id });
  }

  if (replaceable.length === 0) return { traces: 0, stints: 0, quests: 0, kept };
  const plan = planReset(database, replaceable);
  plan.sessionIds = [];
  const result = applyReset(database, plan, { reason: "declaration covers window" });
  return { traces: result.traces, stints: result.stints, quests: result.quests, kept };
}
