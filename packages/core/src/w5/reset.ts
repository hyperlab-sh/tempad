import type { Database } from "bun:sqlite";
import { applyIncremental } from "../intent/projections";
import { EventStore } from "../intent/store";

/** A live trace a reset is about to retract. */
export interface ResetTrace {
  id: string;
  stint_id: string;
  session_id: string | null;
}

export interface ResetResult {
  traces: number;
  stints: number;
  quests: number;
  /** Open questions about the retracted traces, closed. */
  questions: number;
  /** Surviving stints whose `continues` pointed at a retracted stint, cleared. */
  continuations: number;
}

/** What a reset would retract, computed without writing anything. */
export interface ResetPlan {
  traces: ResetTrace[];
  /** Stints left with no live trace once `traces` are retracted. */
  stintIds: string[];
  /** Unconfirmed quests left with no live stint once `stintIds` are retracted. */
  questIds: string[];
  /**
   * Questions about the retracted traces that nobody answered (`watching`, `asked`
   * or `expired`), closed so neither the hook nor `tempad review` raises them.
   */
  questionIds: string[];
  /** Live stints that stay but continue a stint in `stintIds`. */
  continuationIds: string[];
  /** Sessions whose `w5_runs.session_note` and `w5_windows` rows are cleared. */
  sessionIds: string[];
}

export interface ResetOptions {
  reason: string;
  /**
   * Whether to delete the `w5_windows` rows of the touched sessions. `w5_windows`
   * is a projection of `window.classified` events, so a delete is not an event:
   * a `tempad rebuild` (or `scry`'s projection check) replays the deleted rows
   * back. Only a throwaway copy may do it, which is what `w5 eval` runs on.
   */
  clearWindowCoverage: boolean;
}

/** Questions about these traces that were never answered (a person's answer or the context's). */
function openQuestionsOf(database: Database, traceIds: string[]): string[] {
  if (traceIds.length === 0) return [];
  return (
    database
      .query(
        `SELECT id FROM questions
          WHERE trace_id IN (SELECT value FROM json_each(?))
            AND state IN ('watching', 'asked', 'expired')
          ORDER BY rowid ASC`,
      )
      .all(JSON.stringify(traceIds)) as { id: string }[]
  ).map((row) => row.id);
}

/**
 * The cascade behind `w5 eval`'s reset (on its throwaway copy), mirroring
 * `dedupe.ts`: the given traces, then the stints left with no live trace, then
 * the unconfirmed quests left with no live stint. A stint that keeps a live
 * trace (another session's, or one the caller did not select) stays, and so
 * does its quest.
 */
export function planReset(database: Database, traces: ResetTrace[]): ResetPlan {
  const retractedTraceIds = new Set(traces.map((trace) => trace.id));
  const sessionIds = [
    ...new Set(traces.map((trace) => trace.session_id).filter((id): id is string => id !== null)),
  ];

  const stintIds: string[] = [];
  for (const stintId of new Set(traces.map((trace) => trace.stint_id))) {
    const live = database
      .query("SELECT id FROM traces WHERE stint_id = ? AND retracted_at IS NULL")
      .all(stintId) as { id: string }[];
    if (!live.some((trace) => !retractedTraceIds.has(trace.id))) stintIds.push(stintId);
  }

  const retractedStintIds = new Set(stintIds);
  const affectedQuestIds = new Set(
    stintIds
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
  const questIds: string[] = [];
  for (const questId of affectedQuestIds) {
    const quest = database
      .query("SELECT confirmed FROM quests WHERE id = ? AND retracted_at IS NULL")
      .get(questId) as { confirmed: number } | null;
    if (!quest || quest.confirmed === 1) continue;
    const liveStints = database
      .query("SELECT id FROM stints WHERE quest_id = ? AND retracted_at IS NULL")
      .all(questId) as { id: string }[];
    if (!liveStints.some((stint) => !retractedStintIds.has(stint.id))) questIds.push(questId);
  }

  const questionIds = openQuestionsOf(database, [...retractedTraceIds]);

  const continuationIds =
    stintIds.length === 0
      ? []
      : (
          database
            .query(
              `SELECT id FROM stints
                WHERE retracted_at IS NULL AND continues IN (SELECT value FROM json_each(?))`,
            )
            .all(JSON.stringify(stintIds)) as { id: string }[]
        )
          .map((row) => row.id)
          .filter((id) => !retractedStintIds.has(id));

  return { traces, stintIds, questIds, questionIds, continuationIds, sessionIds };
}

/**
 * Appends one `retracted` event per row of the plan, in one transaction (events
 * stay append-only: nothing is deleted or edited), and clears the session note
 * of every touched session (and, for a throwaway copy only, its `w5_windows`
 * coverage: see `clearWindowCoverage`).
 */
export function applyReset(
  database: Database,
  plan: ResetPlan,
  options: Pick<ResetOptions, "reason" | "clearWindowCoverage">,
): ResetResult {
  const store = new EventStore(database);
  const retract = (subject: string) =>
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "retracted",
        subject,
        payload: { retracts: subject, reason: options.reason },
      }),
    );

  database.transaction(() => {
    for (const trace of plan.traces) retract(trace.id);
    for (const stintId of plan.stintIds) retract(stintId);
    for (const questId of plan.questIds) retract(questId);
    // A question about a retracted trace is void. `resolved_by_context` is the
    // terminal state nothing lists or asks, and the event carries the reason.
    for (const questionId of plan.questionIds) {
      applyIncremental(
        database,
        store.append({
          actor: "backfill",
          kind: "question.answered",
          subject: questionId,
          payload: { answeredBy: "context", reason: options.reason },
        }),
      );
    }
    for (const stintId of plan.continuationIds) {
      applyIncremental(
        database,
        store.append({
          actor: "backfill",
          kind: "stint.continuation_cleared",
          subject: stintId,
          payload: { reason: options.reason },
        }),
      );
    }
    for (const sessionId of plan.sessionIds) {
      database.query("UPDATE w5_runs SET session_note = NULL WHERE session_id = ?").run(sessionId);
      if (options.clearWindowCoverage) {
        database.query("DELETE FROM w5_windows WHERE session_id = ?").run(sessionId);
      }
    }
  })();

  return {
    traces: plan.traces.length,
    stints: plan.stintIds.length,
    quests: plan.questIds.length,
    questions: plan.questionIds.length,
    continuations: plan.continuationIds.length,
  };
}
