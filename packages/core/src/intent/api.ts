import type { Database } from "bun:sqlite";
import type { Actor } from "./events";
import { newUlid } from "./ids";
import { applyIncremental } from "./projections";
import { registerAllProjections } from "./projections/register";
import type { EventStore } from "./store";

export const THEME_PATTERN = /^[a-z][a-z-]*$/;

// Projections must be registered before applyIncremental can materialize any
// row -- intent/cli.ts does this on startup, but a caller reaching this
// module directly (never importing cli.ts) would otherwise get silent
// no-op projections. registerAllProjections() is idempotent.
registerAllProjections();

export interface OpenStintInput {
  quest?: string;
  outcome: string;
  at?: string;
  actor: Actor;
}

export function openStint(store: EventStore, database: Database, input: OpenStintInput): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: input.actor,
      kind: "stint.opened",
      subject: id,
      payload: { quest: input.quest, outcome: input.outcome },
      at: input.at,
    }),
  );
  return id;
}

export function assignStint(
  store: EventStore,
  database: Database,
  stintId: string,
  questId: string,
  actor: Actor,
): void {
  applyIncremental(
    database,
    store.append({
      actor,
      kind: "stint.assigned",
      subject: stintId,
      payload: { quest: questId },
    }),
  );
}

export interface TraceInput {
  stint: string;
  tool: string;
  place: string;
  source: string;
  sourceRef?: string;
  startedAt: string;
  endedAt: string;
  who: string;
  what: string;
  why: string;
  where: string;
  how: string;
  confidence: number;
  classifiedBy: string;
  actor: Actor;
  sessionId?: string;
  /**
   * Declared mode only: the verifier's per-segment verdict, carried on the
   * event so it survives into the `traces.doubt` column even when no question
   * is ever asked about it. Absent for an inference-mode trace.
   */
  belongs?: boolean;
  guess?: string | null;
  /** The transcript text behind a doubt; carried on the event only (`tempad review` reads it). */
  trigger?: string | null;
}

export function recordTrace(store: EventStore, database: Database, input: TraceInput): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: input.actor,
      kind: "trace.recorded",
      subject: id,
      sessionId: input.sessionId,
      payload: {
        stint: input.stint,
        tool: input.tool,
        place: input.place,
        source: input.source,
        source_ref: input.sourceRef,
        started_at: input.startedAt,
        ended_at: input.endedAt,
        who: input.who,
        what: input.what,
        why: input.why,
        where: input.where,
        how: input.how,
        confidence: input.confidence,
        classified_by: input.classifiedBy,
        belongs: input.belongs,
        guess: input.guess,
        trigger: input.trigger ?? undefined,
      },
    }),
  );
  return id;
}

export function relinkTrace(
  store: EventStore,
  database: Database,
  traceId: string,
  stintId: string,
  reason: string,
  actor: Actor,
): void {
  applyIncremental(
    database,
    store.append({
      actor,
      kind: "trace.relinked",
      subject: traceId,
      payload: { stint: stintId, reason },
    }),
  );
}

export interface AskQuestionInput {
  trace: string;
  sessionId?: string;
  kind: string;
  text: string;
  /** What the verifier thinks the work looks like instead, for a `belongs` question. */
  guess?: string | null;
  isSwitch?: boolean;
  actor: Actor;
}

export function askQuestion(
  store: EventStore,
  database: Database,
  input: AskQuestionInput,
): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: input.actor,
      kind: "question.asked",
      subject: id,
      sessionId: input.sessionId,
      payload: {
        trace: input.trace,
        kind: input.kind,
        text: input.text,
        guess: input.guess ?? undefined,
        is_switch: input.isSwitch ?? false,
      },
    }),
  );
  return id;
}

export function answerQuestion(
  store: EventStore,
  database: Database,
  questionId: string,
  quest: string,
  why: string | undefined,
  actor: Actor,
): void {
  applyIncremental(
    database,
    store.append({
      actor,
      kind: "question.answered",
      subject: questionId,
      payload: { quest, why, answeredBy: actor },
    }),
  );
}

export function expireQuestion(
  store: EventStore,
  database: Database,
  questionId: string,
  actor: Actor,
): void {
  applyIncremental(
    database,
    store.append({ actor, kind: "question.expired", subject: questionId, payload: {} }),
  );
}

export interface StateImpactInput {
  subject: string;
  text: string;
  theme?: string | null;
  hero: Actor;
}

export function stateImpact(
  store: EventStore,
  database: Database,
  input: StateImpactInput,
): string {
  if (input.theme != null && !THEME_PATTERN.test(input.theme)) {
    throw new Error(`--theme must match ^[a-z][a-z-]*$: ${input.theme}`);
  }
  const event = store.append({
    actor: input.hero,
    kind: "impact.stated",
    subject: input.subject,
    payload: { text: input.text, theme: input.theme ?? null },
  });
  applyIncremental(database, event);
  return String(event.id);
}

export interface ImpactRow {
  text: string;
  theme: string | null;
}

const QUERY_IMPACTS_CHUNK_SIZE = 500;

export function queryImpacts(database: Database, subjects: string[]): Map<string, ImpactRow> {
  const result = new Map<string, ImpactRow>();
  for (let index = 0; index < subjects.length; index += QUERY_IMPACTS_CHUNK_SIZE) {
    const chunk = subjects.slice(index, index + QUERY_IMPACTS_CHUNK_SIZE);
    const rows = database
      .query(
        `SELECT subject, text, theme FROM impacts
         WHERE retracted_at IS NULL AND subject IN (${chunk.map(() => "?").join(", ")})`,
      )
      .all(...chunk) as { subject: string; text: string; theme: string | null }[];
    for (const row of rows) result.set(row.subject, { text: row.text, theme: row.theme });
  }
  return result;
}
