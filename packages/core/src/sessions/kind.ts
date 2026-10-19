import type { Database } from "bun:sqlite";
import { readLines } from "../collect/claude";
import { applyIncremental } from "../intent/projections";
import {
  effectiveKindColumns,
  loadSessions,
  recomputeSessionKindRules,
  type SessionRecord,
  sessionKindProjection,
  sessionKindSql,
} from "../intent/projections/session-kind";
import { EventStore } from "../intent/store";
import { ClassifierResponseError } from "../w5/classifier-shared";
import type { SessionKindClassifier } from "./classifier";
import type { SessionKind } from "./kinds";

/**
 * Bumped when the rules or the model prompt change meaning: every model row
 * stamped with an older version is classified again on the next pass.
 */
export const SESSION_KIND_CLASSIFIER_VERSION = 1;

export interface RefreshSessionKindsOptions {
  /** Null runs the rules only. */
  classifier: SessionKindClassifier | null;
  /** The model the classifier answers for; recorded on each `session.kind_inferred` event. */
  model: string;
  /** The most sessions sent to the model in this pass. */
  modelLimit: number;
  /** When set, only this host's sessions go to the model (their transcripts are here). */
  hostSlug?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface RefreshSessionKindsResult {
  /** Sessions a rule classifies whose rule row changed this pass. */
  ruled: number;
  /** Rule rows removed because their rule no longer fires. */
  cleared: number;
  modeled: number;
  failed: number;
  /** Sessions still waiting for the model after this pass. */
  pending: number;
}

interface OriginRow {
  session_id: string;
  origin: string;
  classifier_version: number;
}

/**
 * One pass over every Claude session: the rules rewrite the rule rows for every
 * session, then the model classifies at most `modelLimit` of the rest, newest
 * first, and every answer is recorded as a `session.kind_inferred` event, so a
 * rebuild replays it instead of calling the model again. A session with a manual
 * kind, or a model row of the current classifier version, is never sent. A
 * failed call writes nothing, so the session is tried again on the next pass; a
 * failure that is not a bad answer (the call itself failed) ends the batch.
 */
export async function refreshSessionKinds(
  database: Database,
  options: RefreshSessionKindsOptions,
): Promise<RefreshSessionKindsResult> {
  const log = options.log ?? ((line: string) => console.error(line));
  const result: RefreshSessionKindsResult = {
    ruled: 0,
    cleared: 0,
    modeled: 0,
    failed: 0,
    pending: 0,
  };
  ensureSessionKindTables(database);
  const rules = recomputeSessionKindRules(database, SESSION_KIND_CLASSIFIER_VERSION);
  result.ruled = rules.ruled;
  result.cleared = rules.cleared;

  const rows = database
    .query("SELECT session_id, origin, classifier_version FROM session_kind")
    .all() as OriginRow[];
  const hasManual = new Set<string>();
  const hasCurrentModel = new Set<string>();
  for (const row of rows) {
    if (row.origin === "manual") hasManual.add(row.session_id);
    else if (row.origin === "model" && row.classifier_version === SESSION_KIND_CLASSIFIER_VERSION)
      hasCurrentModel.add(row.session_id);
  }
  // A rule row means the rules own the session; only their leftovers reach the model.
  const ruledSessions = new Set(
    (
      database.query("SELECT session_id FROM session_kind WHERE origin = 'rule'").all() as {
        session_id: string;
      }[]
    ).map((row) => row.session_id),
  );

  const leftovers: SessionRecord[] = [];
  for (const session of loadSessions(database)) {
    const id = session.facts.id;
    if (ruledSessions.has(id) || hasManual.has(id) || hasCurrentModel.has(id)) continue;
    if (options.hostSlug !== undefined && session.hostSlug !== options.hostSlug) continue;
    leftovers.push(session);
  }

  leftovers.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const batch = options.classifier ? leftovers.slice(0, options.modelLimit) : [];
  result.pending = leftovers.length - batch.length;
  for (const [index, session] of batch.entries()) {
    const opener = session.facts.opener;
    if (!options.classifier || opener === null) continue;
    const text = (await fullMessageText(session.filePath, opener.uuid)) ?? opener.text;
    try {
      const guess = await options.classifier.classifyOpener(text);
      const event = new EventStore(database).append({
        actor: "hero",
        kind: "session.kind_inferred",
        subject: session.facts.id,
        payload: {
          kind: guess.kind,
          confidence: guess.confidence,
          model: options.model,
          classifier_version: SESSION_KIND_CLASSIFIER_VERSION,
          opener_sha256: hashOpener(text),
        },
      });
      applyIncremental(database, event);
      result.modeled += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`sessions: kind of ${session.facts.id} not classified: ${message}`);
      result.failed += 1;
      // A bad answer is about this message; anything else (no `claude` binary, a
      // timeout, a non-zero exit) would fail every remaining call the same way.
      if (!(error instanceof ClassifierResponseError)) {
        result.pending += batch.length - index - 1;
        break;
      }
    }
  }
  return result;
}

/** A short digest of the first message, so a replayed decision names the text it judged. */
function hashOpener(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * The whole text of one message from the session's transcript, since the
 * database keeps only its first 500 characters. Null when the file or the line
 * is gone (a pulled session, a deleted transcript): the caller uses the preview.
 */
async function fullMessageText(filePath: string, uuid: string): Promise<string | null> {
  try {
    for await (const line of readLines(filePath)) {
      if (!line.includes(uuid)) continue;
      let parsed: { uuid?: unknown; message?: { content?: unknown } };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.uuid !== uuid) continue;
      const content = parsed.message?.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return null;
      const texts = content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" &&
            block !== null &&
            block.type === "text" &&
            typeof block.text === "string",
        )
        .map((block) => block.text);
      return texts.length > 0 ? texts.join("") : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Creates the kind table when the projections have not been set up on this
 * database yet, so reading a kind never fails on a fresh home.
 */
export function ensureSessionKindTables(database: Database): void {
  database.exec(sessionKindProjection.createSql);
}

export interface EffectiveSessionKind {
  kind: SessionKind;
  /** `manual`, `model` or `rule:<name>`. */
  source: string;
  confidence: number;
}

/**
 * A manual kind wins, then a rule, then a model decision; null when nothing
 * knows the session yet.
 */
export function effectiveSessionKind(
  database: Database,
  sessionId: string,
): EffectiveSessionKind | null {
  ensureSessionKindTables(database);
  return (
    (database
      .query(
        `SELECT kind, source, confidence FROM session_kind
         WHERE session_id = ?
         ORDER BY CASE origin WHEN 'manual' THEN 0 WHEN 'rule' THEN 1 ELSE 2 END
         LIMIT 1`,
      )
      .get(sessionId) as EffectiveSessionKind | null) ?? null
  );
}

export { ruleKind, type SessionFacts } from "../intent/projections/session-kind";
export { effectiveKindColumns, sessionKindSql };

/**
 * Records a kind given by hand as a `session.kind_set` event, or hands the
 * session back to inference with `kind: null`.
 */
export function setSessionKind(
  database: Database,
  sessionId: string,
  kind: SessionKind | null,
): void {
  const event = new EventStore(database).append({
    actor: "hero",
    kind: "session.kind_set",
    subject: sessionId,
    payload: { kind },
  });
  applyIncremental(database, event);
}
