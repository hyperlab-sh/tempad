import type { Database } from "bun:sqlite";
import { isSessionKind, SESSION_KINDS, type SessionKind } from "../../sessions/kinds";
import type { EventRecord } from "../events";
import type { Projection, ProjectionReplay } from "./index";

/**
 * The kind of every Claude session (human, lead, subagent, automated) is a
 * projection, not a cache: `tempad rebuild` reconstructs it from the event log
 * (a kind set by hand, a model decision) and from the collected facts (the
 * rules), with no model call. One row per session and origin:
 *
 * - `manual` — the latest `session.kind_set` event (a person's decision, which
 *   always wins). A `kind` of null (`--clear`) deletes it.
 * - `model`  — the latest `session.kind_inferred` event (what the small model
 *   answered, with the model, classifier version and a hash of the first
 *   message, so the decision replays without calling the model again).
 * - `rule`   — the cheapest rule that fires over the collected facts
 *   (`claude_sessions`/`claude_messages`/declarations), recomputed by every
 *   kind pass and after a rebuild.
 *
 * Within an origin the latest event by `(at, uid)` wins, so a backdated event
 * arriving later cannot overwrite a newer decision, and events replayed out of
 * insertion order converge to the same rows. A manual row always beats an
 * inferred one whatever their `at`s: a person's correction is final until the
 * next person's decision.
 */
const SESSION_KIND_SQL = `
  CREATE TABLE IF NOT EXISTS session_kind (
    session_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('manual', 'model', 'rule')),
    kind TEXT NOT NULL CHECK (kind IN ('human', 'lead', 'subagent', 'automated')),
    source TEXT NOT NULL,
    confidence REAL NOT NULL,
    classifier_version INTEGER NOT NULL,
    set_at TEXT NOT NULL,
    event_uid TEXT,
    PRIMARY KEY (session_id, origin)
  )`;

export const sessionKindProjection: Projection = {
  name: "session_kind",
  tables: ["session_kind"],
  createSql: SESSION_KIND_SQL,
  apply(database: Database, event: EventRecord, replay?: ProjectionReplay): void {
    if (event.uid === null) return; // not orderable against replayed rows
    if (event.kind === "session.kind_set") applySet(database, event, replay);
    else if (event.kind === "session.kind_inferred") applyInferred(database, event);
  },
  /**
   * The rule rows die with the truncate; the rules recompute them from the
   * collected facts, so a rebuild restores the rule-derived kinds too (and
   * the model rows come back from the replayed `session.kind_inferred`
   * events). Skipped when the target has no collector tables (a time-travel
   * in-memory database).
   */
  afterRebuild(database: Database): void {
    recomputeSessionKindRules(database, SESSION_KIND_CLASSIFIER_VERSION_LATEST);
  },
};

/**
 * Rules stamp the classifier version of the code that computed them; a rebuild
 * uses the running one, since the facts are re-derived from scratch.
 */
const SESSION_KIND_CLASSIFIER_VERSION_LATEST = 1;

/** Upserts the row unless the stored one is newer by `(at, uid)`. */
function upsertOrdered(
  database: Database,
  event: EventRecord,
  origin: "manual" | "model",
  kind: SessionKind,
  source: string,
  confidence: number,
  classifierVersion: number,
): void {
  database
    .query(
      `INSERT INTO session_kind
         (session_id, origin, kind, source, confidence, classifier_version, set_at, event_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, origin) DO UPDATE SET
         kind = excluded.kind, source = excluded.source,
         confidence = excluded.confidence, classifier_version = excluded.classifier_version,
         set_at = excluded.set_at, event_uid = excluded.event_uid
       WHERE (excluded.set_at, excluded.event_uid) > (session_kind.set_at, session_kind.event_uid)`,
    )
    .run(event.subject, origin, kind, source, confidence, classifierVersion, event.at, event.uid);
}

function applySet(database: Database, event: EventRecord, replay?: ProjectionReplay): void {
  const kind = event.payload.kind;
  if (kind === null) {
    // A clear removes only the manual decision, and only when it is not older
    // than the set it would undo: a backdated clear must not erase a newer set.
    database
      .query(
        `DELETE FROM session_kind
         WHERE session_id = ? AND origin = 'manual'
           AND (set_at, event_uid) <= (?, ?)`,
      )
      .run(event.subject, event.at, event.uid);
    return;
  }
  if (!isSessionKind(kind)) return;
  // A set older than a later clear must not resurrect the manual decision
  // once the clear has deleted its row. The event log is the only witness,
  // so the guard reads it: no later kind-less `session.kind_set` may exist.
  // The guard is bounded by the replay horizon (`tempad rebuild --until`): a
  // clear past the requested date was never applied, so the set it would
  // undo still holds in that historical rebuild (and matches `stateAsOf`,
  // whose target only ever holds in-horizon events). A live apply has no
  // horizon, so the bound is the end of time.
  const laterClear = database
    .query(
      "SELECT 1 FROM events WHERE kind = 'session.kind_set' AND subject = ? AND (at, uid) > (?, ?) AND json_extract(payload, '$.kind') IS NULL AND at <= ? LIMIT 1",
    )
    .get(event.subject, event.at, event.uid, replay?.until ?? "9999-12-31T23:59:59.999Z");
  if (laterClear !== null) return;
  upsertOrdered(database, event, "manual", kind, "manual", 1, 1);
}

function applyInferred(database: Database, event: EventRecord): void {
  const kind = event.payload.kind;
  if (!isSessionKind(kind)) return;
  const confidence = event.payload.confidence;
  const version = event.payload.classifier_version;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) return;
  upsertOrdered(database, event, "model", kind, "model", confidence, version);
}

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
  /** `rule:<name>`, stored as the rule row's `source`. */
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

export interface SessionRecord {
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

/** The collected-facts tables the rules read; absent in a fresh rebuild target. */
function hasClaudeTables(database: Database): boolean {
  return (
    database
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claude_sessions'")
      .get() !== null
  );
}

export function loadSessions(database: Database): SessionRecord[] {
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

export interface RecomputeRulesResult {
  /** Sessions a rule now classifies whose rule row changed. */
  ruled: number;
  /** Rule rows removed because their rule no longer fires. */
  cleared: number;
}

/**
 * Rewrites every rule row from the collected facts. Deterministic given the
 * facts: the same database always yields the same rows, so a rebuild restores
 * the rule-derived kinds exactly, and a pass only changes a row when a fact
 * moved under it.
 */
export function recomputeSessionKindRules(
  database: Database,
  classifierVersion: number,
): RecomputeRulesResult {
  const oldRows = new Map(
    (
      database.query("SELECT session_id, source FROM session_kind WHERE origin = 'rule'").all() as {
        session_id: string;
        source: string;
      }[]
    ).map((row) => [row.session_id, row.source]),
  );
  database.exec("DELETE FROM session_kind WHERE origin = 'rule'");
  const insert = database.query(
    `INSERT INTO session_kind
       (session_id, origin, kind, source, confidence, classifier_version, set_at, event_uid)
     VALUES (?, 'rule', ?, ?, ?, ?, ?, NULL)`,
  );
  let ruled = 0;
  if (hasClaudeTables(database)) {
    for (const session of loadSessions(database)) {
      const hit = ruleKind(session.facts);
      if (hit === null) continue;
      // set_at is the session's own started_at, not the wall clock: two hosts
      // that mirror the same sessions compute identical rows, so a rebuilt
      // snapshot (which compares set_at) converges.
      insert.run(
        session.facts.id,
        hit.kind,
        hit.source,
        hit.confidence,
        classifierVersion,
        session.startedAt,
      );
      if (oldRows.get(session.facts.id) !== hit.source) ruled += 1;
    }
  }
  const newKeys = new Set(
    (
      database.query("SELECT session_id FROM session_kind WHERE origin = 'rule'").all() as {
        session_id: string;
      }[]
    ).map((row) => row.session_id),
  );
  let cleared = 0;
  for (const id of oldRows.keys()) if (!newKeys.has(id)) cleared += 1;
  return { ruled, cleared };
}

/**
 * The SQL expression for a session's effective kind, given an expression for its
 * id: for a `WHERE <sessionKindSql("t.session_id")> = ?` filter.
 */
export function sessionKindSql(sessionIdExpression: string): string {
  return `(
    SELECT kind FROM session_kind WHERE session_id = ${sessionIdExpression}
    ORDER BY CASE origin WHEN 'manual' THEN 0 WHEN 'rule' THEN 1 ELSE 2 END
    LIMIT 1)`;
}

/** Column picks for list-style queries: the kind and its source in two subqueries. */
export function effectiveKindColumns(sessionIdExpression: string): string {
  return `${sessionKindSql(sessionIdExpression)} AS effective_kind,
    (SELECT source FROM session_kind WHERE session_id = ${sessionIdExpression}
     ORDER BY CASE origin WHEN 'manual' THEN 0 WHEN 'rule' THEN 1 ELSE 2 END
     LIMIT 1) AS effective_source`;
}

export const SESSION_KIND_VALUES_SQL = `'${SESSION_KINDS.join("', '")}'`;
