import type { Database } from "bun:sqlite";
import type { W5Config } from "../intent/config";
import { sessionHasActiveDeclaration } from "../intent/declarations";
import { applyIncremental } from "../intent/projections";
import type { EventStore } from "../intent/store";

export interface QuestionRow {
  id: string;
  traceId: string;
  sessionId: string | null;
  kind: string;
  state: string;
  turnsWatched: number;
  turnsAtAsk: number | null;
  isSwitch: boolean;
}

interface RawQuestionRow {
  id: string;
  trace_id: string;
  session_id: string | null;
  kind: string;
  state: string;
  turns_watched: number;
  turns_at_ask: number | null;
  is_switch: number;
}

function toQuestionRow(row: RawQuestionRow): QuestionRow {
  return {
    id: row.id,
    traceId: row.trace_id,
    sessionId: row.session_id,
    kind: row.kind,
    state: row.state,
    turnsWatched: row.turns_watched,
    turnsAtAsk: row.turns_at_ask,
    isSwitch: row.is_switch === 1,
  };
}

export interface AdvanceQuestionsInput {
  sessionId: string;
  now: string;
  turnsSinceLastRun: number;
  sessionStintMinutes: number;
  resolvedByContext: string[];
}

export interface AdvanceQuestionsResult {
  asked: QuestionRow[];
  expired: QuestionRow[];
  resolved: QuestionRow[];
}

function isQuiet(database: Database, now: string): boolean {
  const row = database.query("SELECT until FROM w5_quiet ORDER BY rowid DESC LIMIT 1").get() as {
    until: string;
  } | null;
  return row !== null && row.until > now;
}

function hasRecentAsk(
  database: Database,
  sessionId: string,
  now: string,
  budgetMinutes: number,
): boolean {
  const row = database
    .query(
      `SELECT asked_at FROM questions
        WHERE session_id = ? AND asked_at IS NOT NULL
        ORDER BY asked_at DESC LIMIT 1`,
    )
    .get(sessionId) as { asked_at: string } | null;
  if (!row) return false;
  const elapsedMinutes = (Date.parse(now) - Date.parse(row.asked_at)) / 60_000;
  return elapsedMinutes < budgetMinutes;
}

function hasUnansweredAsked(database: Database, sessionId: string): boolean {
  const row = database
    .query(
      `SELECT id FROM questions WHERE session_id = ? AND state = 'asked' AND ${TRACE_NOT_RETRACTED} LIMIT 1`,
    )
    .get(sessionId) as { id: string } | null;
  return row !== null;
}

function watchQuestion(
  store: EventStore,
  database: Database,
  questionId: string,
  turns: number,
  now: string,
): void {
  applyIncremental(
    database,
    store.append({
      actor: "system",
      kind: "question.watched",
      subject: questionId,
      at: now,
      payload: { turns },
    }),
  );
}

function promoteQuestion(
  store: EventStore,
  database: Database,
  questionId: string,
  turnsAtAsk: number,
  now: string,
): void {
  applyIncremental(
    database,
    store.append({
      actor: "system",
      kind: "question.promoted",
      subject: questionId,
      at: now,
      payload: { turnsAtAsk },
    }),
  );
}

/**
 * SQL for a `questions` row whose trace is not retracted. A question about a trace
 * that no longer exists (a `w5 dedupe` retracted it, or a `w5 eval` reset on its copy) is void: the hook must
 * not ask it, `tempad review` not list it. A question whose trace row is missing
 * altogether is kept, as before.
 */
export const TRACE_NOT_RETRACTED = `NOT EXISTS (SELECT 1 FROM traces
   WHERE traces.id = questions.trace_id AND traces.retracted_at IS NOT NULL)`;

function expireQuestion(
  store: EventStore,
  database: Database,
  questionId: string,
  now: string,
): void {
  applyIncremental(
    database,
    store.append({
      actor: "system",
      kind: "question.expired",
      subject: questionId,
      at: now,
      payload: {},
    }),
  );
}

function resolveByContext(
  store: EventStore,
  database: Database,
  questionId: string,
  now: string,
): void {
  applyIncremental(
    database,
    store.append({
      actor: "system",
      kind: "question.answered",
      subject: questionId,
      at: now,
      payload: { answeredBy: "context" },
    }),
  );
}

/**
 * `declare` questions the session has since answered by declaring a quest. The
 * question is queued while the session has declared nothing and then watched for
 * `watchTurns` turns, so the declaration usually lands between queueing and
 * asking (or while the question is already asked); `w5 context` would then tell
 * a session that has an active quest that it has none. Uses
 * `sessionHasActiveDeclaration`, the resolution `buildWindow` applies when it
 * decides a window needs a `declare` question (a subagent's own or its parent's
 * quests included), so a quest that was ended (`--done`) or retracted does not
 * count and the question stands.
 */
function declareQuestionsAnsweredByDeclaration(
  database: Database,
  input: AdvanceQuestionsInput,
): string[] {
  const open = database
    .query(
      "SELECT id FROM questions WHERE session_id = ? AND kind = 'declare' AND state IN ('watching', 'asked')",
    )
    .all(input.sessionId) as { id: string }[];
  if (open.length === 0) return [];
  return sessionHasActiveDeclaration(database, { sessionId: input.sessionId, at: input.now })
    ? open.map((row) => row.id)
    : [];
}

export function advanceQuestions(
  store: EventStore,
  database: Database,
  config: W5Config,
  input: AdvanceQuestionsInput,
): AdvanceQuestionsResult {
  const asked: QuestionRow[] = [];
  const expired: QuestionRow[] = [];
  const resolved: QuestionRow[] = [];

  const watchingRows = database
    .query(
      `SELECT id, trace_id, session_id, kind, state, turns_watched, turns_at_ask, is_switch
         FROM questions
        WHERE session_id = ? AND state = 'watching' AND ${TRACE_NOT_RETRACTED}
        ORDER BY rowid ASC`,
    )
    .all(input.sessionId) as RawQuestionRow[];

  const resolvedSet = new Set(input.resolvedByContext);
  for (const id of declareQuestionsAnsweredByDeclaration(database, input)) resolvedSet.add(id);

  for (const raw of watchingRows) {
    const row = toQuestionRow(raw);

    if (resolvedSet.has(row.id)) {
      resolveByContext(store, database, row.id, input.now);
      resolved.push({ ...row, state: "resolved_by_context" });
      continue;
    }

    const newTurnsWatched = row.turnsWatched + input.turnsSinceLastRun;
    watchQuestion(store, database, row.id, newTurnsWatched, input.now);

    const trace = database
      .query(
        `SELECT traces.id as traceId, stints.quest_id as questId
           FROM traces JOIN stints ON stints.id = traces.stint_id
          WHERE traces.id = ?`,
      )
      .get(row.traceId) as { traceId: string; questId: string | null } | null;

    if (row.kind === "belongs") {
      const dismissed = database
        .query(
          `SELECT stints.dismissed_at as dismissedAt FROM traces
             JOIN stints ON stints.id = traces.stint_id
            WHERE traces.id = ?`,
        )
        .get(row.traceId) as { dismissedAt: string | null } | null;
      if (dismissed?.dismissedAt !== null && dismissed?.dismissedAt !== undefined) {
        expireQuestion(store, database, row.id, input.now);
        expired.push({ ...row, state: "expired", turnsWatched: newTurnsWatched });
        continue;
      }
    }

    if (row.kind === "why" && trace?.questId !== null && trace?.questId !== undefined) {
      expireQuestion(store, database, row.id, input.now);
      expired.push({ ...row, state: "expired", turnsWatched: newTurnsWatched });
      continue;
    }

    if (newTurnsWatched < config.watchTurns) continue;

    // The verifier's two kinds carry their own reason to ask, so they promote on
    // the watch_turns rule alone. The stint heuristic below is inference-only:
    // it asks when a stretch of work has no quest, but in declared mode every
    // stint is given the declared quest, so a `belongs` question would never
    // qualify and would sit in `watching` forever -- never asked, never expired.
    const qualifiesByKind = row.kind === "belongs" || row.kind === "declare";
    const qualifiesOnSwitch = row.kind === "which_quest" && row.isSwitch;
    const qualifiesOnStint =
      input.sessionStintMinutes >= config.askMinStintMinutes &&
      (trace?.questId === null || trace?.questId === undefined);

    if (!qualifiesByKind && !qualifiesOnSwitch && !qualifiesOnStint) continue;
    if (hasRecentAsk(database, input.sessionId, input.now, config.askBudgetMinutes)) continue;
    if (hasUnansweredAsked(database, input.sessionId)) continue;
    if (isQuiet(database, input.now)) continue;

    promoteQuestion(store, database, row.id, newTurnsWatched, input.now);
    asked.push({
      ...row,
      state: "asked",
      turnsWatched: newTurnsWatched,
      turnsAtAsk: newTurnsWatched,
    });
  }

  const askedRows = database
    .query(
      `SELECT id, trace_id, session_id, kind, state, turns_watched, turns_at_ask, is_switch
         FROM questions
        WHERE session_id = ? AND state = 'asked' AND ${TRACE_NOT_RETRACTED}`,
    )
    .all(input.sessionId) as RawQuestionRow[];

  for (const raw of askedRows) {
    const row = toQuestionRow(raw);
    if (asked.some((a) => a.id === row.id)) continue;

    if (resolvedSet.has(row.id)) {
      resolveByContext(store, database, row.id, input.now);
      resolved.push({ ...row, state: "resolved_by_context" });
      continue;
    }

    const newTurnsWatched = row.turnsWatched + input.turnsSinceLastRun;
    watchQuestion(store, database, row.id, newTurnsWatched, input.now);

    if (newTurnsWatched - (row.turnsAtAsk ?? 0) >= config.askExpireTurns) {
      expireQuestion(store, database, row.id, input.now);
      expired.push({ ...row, state: "expired", turnsWatched: newTurnsWatched });
    }
  }

  return { asked, expired, resolved };
}
