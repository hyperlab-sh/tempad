import type { Database } from "bun:sqlite";
import { readLines } from "../collect/claude";
import { applyIncremental } from "../intent/projections";
import { sessionKindProjection } from "../intent/projections/session-kind";
import { EventStore } from "../intent/store";
import { ClassifierResponseError } from "../w5/classifier-shared";
import type { SessionKindClassifier } from "./classifier";
import type { SessionKind } from "./kinds";

/**
 * Bumped when the rules or the model prompt change meaning: every model row
 * stamped with an older version is classified again on the next pass.
 */
export const SESSION_KIND_CLASSIFIER_VERSION = 1;

/** The entrypoints of Claude's SDKs and of `claude -p`: a program started the session. */
const AUTOMATION_ENTRYPOINTS = new Set(["sdk-py", "sdk-ts", "sdk-cli"]);

/** What the rules read about one session. */
export interface SessionFacts {
  id: string;
  entrypoint: string | null;
  titleSource: string | null;
  /** Any message of the session came from a typed prompt (`origin.kind = "human"`). */
  hasHumanOrigin: boolean;
  /** The first user message with text, or null when the session has none. */
  opener: { uuid: string; text: string; originKind: string | null } | null;
  /** A `quest.declared` names this session with a parent session. */
  declaredWithParent: boolean;
  /** A `quest.declared` names this session as another session's parent. */
  declaredAsParent: boolean;
}

export interface RuleHit {
  kind: SessionKind;
  /** `rule:<name>`, stored as the cache row's `source`. */
  source: string;
  confidence: number;
}

/**
 * The rules, cheapest first, stopping at the first that fires. Null means no
 * rule knows, and the session is left to the model.
 */
export function ruleKind(facts: SessionFacts): RuleHit | null {
  if (
    facts.entrypoint !== null &&
    AUTOMATION_ENTRYPOINTS.has(facts.entrypoint) &&
    !facts.hasHumanOrigin
  ) {
    return { kind: "automated", source: "rule:entrypoint", confidence: 1 };
  }
  if (facts.opener === null) {
    return { kind: "automated", source: "rule:no-user-messages", confidence: 1 };
  }
  if (facts.declaredWithParent) {
    return { kind: "subagent", source: "rule:declared-parent", confidence: 1 };
  }
  if (facts.titleSource === "agent-name") {
    return { kind: "subagent", source: "rule:agent-name", confidence: 1 };
  }
  // Another Claude session sent the first message (cross-session messaging).
  if (facts.opener.originKind === "peer") {
    return { kind: "subagent", source: "rule:peer-opener", confidence: 1 };
  }
  if (facts.opener.text.trim().startsWith("You are")) {
    return { kind: "subagent", source: "rule:you-are", confidence: 0.9 };
  }
  if (facts.declaredAsParent) {
    return { kind: "lead", source: "rule:parent-of", confidence: 1 };
  }
  return null;
}

interface SessionRow {
  id: string;
  entrypoint: string | null;
  title_source: string | null;
  host_slug: string;
  started_at: string;
  file_path: string;
  has_human_origin: number;
}

interface OpenerRow {
  session_id: string;
  uuid: string;
  text_preview: string;
  origin_kind: string | null;
}

interface SessionRecord {
  facts: SessionFacts;
  hostSlug: string;
  startedAt: string;
  filePath: string;
}

/**
 * The first user message of each session. Lines the CLI writes on the user's
 * behalf (`<command-name>`, `<local-command-stdout>`, the `Caveat:` notice) have
 * no origin and sort after real text, so a session opened with `/clear` still
 * opens with what was typed next; a session with nothing else keeps that line.
 */
const OPENER_SQL = `
  WITH user_text AS (
    SELECT session_id, uuid, ts, text_preview, origin_kind,
           CASE WHEN origin_kind IS NULL
                     AND (substr(text_preview, 1, 1) = '<' OR substr(text_preview, 1, 7) = 'Caveat:')
                THEN 1 ELSE 0 END AS meta
    FROM claude_messages
    WHERE role = 'user' AND text_preview IS NOT NULL AND tool_name IS NULL AND is_sidechain = 0
  ),
  ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY meta, ts, uuid) AS position
    FROM user_text
  )
  SELECT session_id, uuid, text_preview, origin_kind FROM ranked WHERE position = 1`;

function loadSessions(database: Database): SessionRecord[] {
  const sessions = database
    .query(
      `SELECT s.id, s.entrypoint, s.title_source, s.host_slug, s.started_at, s.file_path,
              EXISTS (SELECT 1 FROM claude_messages m
                      WHERE m.session_id = s.id AND m.origin_kind = 'human') AS has_human_origin
       FROM claude_sessions s`,
    )
    .all() as SessionRow[];
  const openers = new Map(
    (database.query(OPENER_SQL).all() as OpenerRow[]).map((row) => [row.session_id, row]),
  );
  const withParent = new Set<string>();
  const asParent = new Set<string>();
  const declarations = database
    .query(
      `SELECT json_extract(payload, '$.session_id') AS session_id,
              json_extract(payload, '$.parent_session_id') AS parent_session_id
       FROM events
       WHERE kind = 'quest.declared' AND json_extract(payload, '$.parent_session_id') IS NOT NULL`,
    )
    .all() as { session_id: unknown; parent_session_id: unknown }[];
  for (const row of declarations) {
    if (typeof row.session_id === "string") withParent.add(row.session_id);
    if (typeof row.parent_session_id === "string") asParent.add(row.parent_session_id);
  }
  return sessions.map((row) => {
    const opener = openers.get(row.id);
    return {
      facts: {
        id: row.id,
        entrypoint: row.entrypoint,
        titleSource: row.title_source,
        hasHumanOrigin: row.has_human_origin === 1,
        opener: opener
          ? { uuid: opener.uuid, text: opener.text_preview, originKind: opener.origin_kind }
          : null,
        declaredWithParent: withParent.has(row.id),
        declaredAsParent: asParent.has(row.id),
      },
      hostSlug: row.host_slug,
      startedAt: row.started_at,
      filePath: row.file_path,
    };
  });
}

interface CacheRow {
  session_id: string;
  kind: string;
  source: string;
  confidence: number;
  classifier_version: number;
}

export interface RefreshSessionKindsOptions {
  /** Null runs the rules only. */
  classifier: SessionKindClassifier | null;
  /** The most sessions sent to the model in this pass. */
  modelLimit: number;
  /** When set, only this host's sessions go to the model (their transcripts are here). */
  hostSlug?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface RefreshSessionKindsResult {
  /** Cache rows a rule wrote or changed. */
  ruled: number;
  /** Rule rows removed because their rule no longer fires. */
  cleared: number;
  modeled: number;
  failed: number;
  /** Sessions still waiting for the model after this pass. */
  pending: number;
}

/**
 * One pass over every Claude session: the rules refresh the cache for every
 * session, then the model classifies at most `modelLimit` of the rest, newest
 * first. A session with a manual kind, or a model row of the current
 * classifier version, is never sent. A failed call writes nothing, so the
 * session is tried again on the next pass; a failure that is not a bad answer
 * (the call itself failed) ends the batch.
 */
export async function refreshSessionKinds(
  database: Database,
  options: RefreshSessionKindsOptions,
): Promise<RefreshSessionKindsResult> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.error(line));
  const result: RefreshSessionKindsResult = {
    ruled: 0,
    cleared: 0,
    modeled: 0,
    failed: 0,
    pending: 0,
  };
  ensureSessionKindTables(database);
  const sessions = loadSessions(database);
  const cache = new Map(
    (
      database
        .query("SELECT session_id, kind, source, confidence, classifier_version FROM session_kind")
        .all() as CacheRow[]
    ).map((row) => [row.session_id, row]),
  );
  const overridden = new Set(
    (
      database.query("SELECT session_id FROM session_kind_overrides").all() as {
        session_id: string;
      }[]
    ).map((row) => row.session_id),
  );
  const upsert = database.query(
    `INSERT INTO session_kind (session_id, kind, source, confidence, classifier_version, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       kind = excluded.kind, source = excluded.source, confidence = excluded.confidence,
       classifier_version = excluded.classifier_version, computed_at = excluded.computed_at`,
  );
  const remove = database.query("DELETE FROM session_kind WHERE session_id = ?");

  const leftovers: SessionRecord[] = [];
  database.transaction(() => {
    const computedAt = now().toISOString();
    for (const session of sessions) {
      const id = session.facts.id;
      const cached = cache.get(id);
      const hit = ruleKind(session.facts);
      if (hit) {
        const same =
          cached !== undefined &&
          cached.kind === hit.kind &&
          cached.source === hit.source &&
          cached.confidence === hit.confidence &&
          cached.classifier_version === SESSION_KIND_CLASSIFIER_VERSION;
        if (!same) {
          upsert.run(
            id,
            hit.kind,
            hit.source,
            hit.confidence,
            SESSION_KIND_CLASSIFIER_VERSION,
            computedAt,
          );
          result.ruled += 1;
        }
        continue;
      }
      if (cached?.source.startsWith("rule:")) {
        remove.run(id);
        result.cleared += 1;
      }
      if (overridden.has(id)) continue;
      if (
        cached?.source === "model" &&
        cached.classifier_version === SESSION_KIND_CLASSIFIER_VERSION
      ) {
        continue;
      }
      if (options.hostSlug !== undefined && session.hostSlug !== options.hostSlug) continue;
      leftovers.push(session);
    }
  })();

  leftovers.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const batch = options.classifier ? leftovers.slice(0, options.modelLimit) : [];
  result.pending = leftovers.length - batch.length;
  for (const [index, session] of batch.entries()) {
    const opener = session.facts.opener;
    if (!options.classifier || opener === null) continue;
    const text = (await fullMessageText(session.filePath, opener.uuid)) ?? opener.text;
    try {
      const guess = await options.classifier.classifyOpener(text);
      upsert.run(
        session.facts.id,
        guess.kind,
        "model",
        guess.confidence,
        SESSION_KIND_CLASSIFIER_VERSION,
        now().toISOString(),
      );
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
 * Creates the manual-kind table when the projections have not been set up on
 * this database yet, so reading a kind never fails on a fresh home.
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

/** A manual kind wins, then the cache; null when neither knows the session yet. */
export function effectiveSessionKind(
  database: Database,
  sessionId: string,
): EffectiveSessionKind | null {
  ensureSessionKindTables(database);
  const manual = database
    .query("SELECT kind FROM session_kind_overrides WHERE session_id = ?")
    .get(sessionId) as { kind: SessionKind } | null;
  if (manual) return { kind: manual.kind, source: "manual", confidence: 1 };
  const cached = database
    .query("SELECT kind, source, confidence FROM session_kind WHERE session_id = ?")
    .get(sessionId) as EffectiveSessionKind | null;
  return cached;
}

/**
 * The SQL expression for a session's effective kind, given an expression for its
 * id: for a `WHERE <sessionKindSql("t.session_id")> = ?` filter.
 */
export function sessionKindSql(sessionIdExpression: string): string {
  return `COALESCE(
    (SELECT kind FROM session_kind_overrides WHERE session_id = ${sessionIdExpression}),
    (SELECT kind FROM session_kind WHERE session_id = ${sessionIdExpression}))`;
}

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
