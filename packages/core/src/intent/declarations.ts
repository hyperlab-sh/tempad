import type { Database } from "bun:sqlite";
import { newUlid } from "./ids";
import { applyIncremental } from "./projections";
import type { EventStore } from "./store";

export type Commitment = "promised" | "personal" | "exploratory";
export type BranchKind = "waiting" | "blocker" | "curiosity" | "unknown";

export interface NewQuestInput {
  title: string;
  outcome: string;
  commitment: Commitment;
  project?: string;
  origin?: string;
  trigger?: string;
  kind?: BranchKind;
  /** `--serves <saga id>`: the saga this quest serves, per the ubiquitous-language spec's relation-verb table. */
  serves?: string;
  /** `--advances <quest id>`: the quest this one contributes to. Payload-only; no column yet (see the rename spec). */
  advances?: string;
}

export interface DeclareQuestInput {
  sessionId: string;
  parentSessionId?: string;
  questId?: string;
  newQuest?: NewQuestInput;
  plan: string[];
  scope: "session" | "subagent";
  declaredBy: "agent" | "hero";
  at: string;
  heroId: string;
  /**
   * Ends the named quest's active declaration for this session. A session
   * accumulates declarations, so retiring one is its own event rather than the
   * side effect of declaring something else.
   */
  done?: boolean;
  /**
   * ISO timestamp the declaration covers the session from, overriding the
   * computed start (see `activeDeclaredQuests`). Never after `at`.
   */
  since?: string;
}

export interface DeclareQuestResult {
  questId: string;
  created: boolean;
}

export function declareQuest(
  store: EventStore,
  database: Database,
  input: DeclareQuestInput,
): DeclareQuestResult {
  let questId = input.questId ?? null;
  let created = false;

  if (input.since !== undefined) {
    if (input.done === true) throw new Error("declareQuest: --since does not apply to --done");
    const since = Date.parse(input.since);
    if (Number.isNaN(since))
      throw new Error(`declareQuest: since is not a timestamp: ${input.since}`);
    if (since > Date.parse(input.at)) {
      throw new Error(`declareQuest: since ${input.since} is after the declaration at ${input.at}`);
    }
  }

  // `--done` always names a quest that already exists: there is nothing to
  // create, and no `new` payload to write.
  if (input.done === true && questId === null) {
    throw new Error("declareQuest: --done requires an existing quest id");
  }

  if (input.done !== true && questId === null && input.newQuest) {
    questId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: input.declaredBy === "hero" ? "hero" : "hook",
        kind: "quest.created",
        subject: questId,
        at: input.at,
        payload: {
          owner: { kind: "hero", id: input.heroId },
          title: input.newQuest.title,
          outcome: input.newQuest.outcome,
          commitment: input.newQuest.commitment,
          serves: input.newQuest.serves,
          advances: input.newQuest.advances,
          confirmed: true,
          origin_kind: "declared",
        },
      }),
    );
    created = true;
    // The new quest is the side quest: the relation goes on its row and names
    // the quest it deviates from. Events written before
    // `deviates_from_quest` existed had the pair inverted; the quests
    // projection reads both (`branchRelation`).
    if (input.newQuest.origin) {
      applyIncremental(
        database,
        store.append({
          actor: input.declaredBy === "hero" ? "hero" : "hook",
          kind: "quest.branched",
          subject: questId,
          at: input.at,
          payload: {
            deviates_from_quest: input.newQuest.origin,
            trigger: input.newQuest.trigger ?? "unknown",
            kind: input.newQuest.kind ?? "unknown",
          },
        }),
      );
    }
  }

  if (questId === null) {
    throw new Error("declareQuest: exactly one of questId or newQuest is required");
  }

  applyIncremental(
    database,
    store.append({
      actor: input.declaredBy === "hero" ? "hero" : "hook",
      kind: "quest.declared",
      subject: questId,
      at: input.at,
      sessionId: input.sessionId,
      payload: {
        session_id: input.sessionId,
        quest_id: questId,
        done: input.done === true ? true : undefined,
        since: input.since,
        new:
          input.done === true || input.newQuest === undefined
            ? undefined
            : {
                title: input.newQuest.title,
                outcome: input.newQuest.outcome,
                commitment: input.newQuest.commitment,
                project: input.newQuest.project,
                origin: input.newQuest.origin,
                trigger: input.newQuest.trigger,
                kind: input.newQuest.kind,
                serves: input.newQuest.serves,
                advances: input.newQuest.advances,
              },
        plan: input.plan,
        scope: input.scope,
        parent_session_id: input.parentSessionId,
        declared_by: input.declaredBy,
        at: input.at,
      },
    }),
  );

  return { questId, created };
}

export interface DeclaredQuest {
  questId: string;
  title: string;
  outcome: string | null;
  plan: string[];
  scope: "session" | "subagent";
  parentSessionId: string | null;
}

/** A `quest.declared` row as the coverage fold reads it. */
export interface DeclarationRow {
  at: string;
  /** Local row id: identifies an event within one database, never across hosts. */
  id?: number;
  uid: string | null;
  payload: {
    quest_id?: string;
    plan?: string[];
    done?: boolean;
    since?: string;
    parent_session_id?: string;
  };
}

/**
 * One stretch during which a quest is declared for a session. `start` is `null`
 * for "the session's own start", which only the database can answer
 * (`claude_sessions.started_at`); everything else is a timestamp.
 */
export interface CoverageInterval {
  questId: string;
  start: string | null;
  /** The `--done` that ended it, or null while it is still active. */
  end: string | null;
  /** The declaration that opened it. */
  declaredAt: string;
  declaredId: number | undefined;
  /** Every declaration of the quest within the interval, oldest first (plan amendments). */
  versions: { at: string; plan: string[] }[];
}

/**
 * Folds declarations (already ordered `at, uid, id`) into coverage intervals.
 * This is the one place the coverage rule lives; see `activeDeclaredQuests`.
 */
export function foldCoverage(rows: DeclarationRow[]): CoverageInterval[] {
  const intervals: CoverageInterval[] = [];
  const open = new Map<string, CoverageInterval>();
  let declaredBefore = false;
  let lastDoneAt: string | null = null;
  for (const row of rows) {
    const questId = row.payload.quest_id;
    if (!questId) continue;
    if (row.payload.done === true) {
      const interval = open.get(questId);
      if (!interval) continue;
      interval.end = row.at;
      open.delete(questId);
      lastDoneAt = row.at;
      continue;
    }
    const existing = open.get(questId);
    if (existing) {
      existing.versions.push({ at: row.at, plan: row.payload.plan ?? [] });
      continue;
    }
    let start: string | null;
    if (row.payload.since !== undefined) start = row.payload.since;
    else if (!declaredBefore) start = null;
    else if (open.size === 0 && lastDoneAt !== null) start = lastDoneAt;
    else start = row.at;
    const interval: CoverageInterval = {
      questId,
      start,
      end: null,
      declaredAt: row.at,
      declaredId: row.id,
      versions: [{ at: row.at, plan: row.payload.plan ?? [] }],
    };
    intervals.push(interval);
    open.set(questId, interval);
    declaredBefore = true;
  }
  return intervals;
}

function sessionStartedAt(database: Database, sessionId: string): string | null {
  const table = database
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claude_sessions'")
    .get();
  if (table === null) return null;
  const row = database
    .query("SELECT started_at FROM claude_sessions WHERE id = ?")
    .get(sessionId) as {
    started_at: string;
  } | null;
  return row?.started_at ?? null;
}

/**
 * The instant an interval starts covering, never after the declaration itself.
 * A session with no stored row has no start to reach back to, so its first
 * declaration covers from its own event.
 */
export function resolveCoverageStart(
  interval: Pick<CoverageInterval, "start" | "declaredAt">,
  sessionStart: string | null,
): string {
  const start = interval.start ?? sessionStart ?? interval.declaredAt;
  return start < interval.declaredAt ? start : interval.declaredAt;
}

function readDeclarations(
  database: Database,
  sessionId: string,
  scope: "session" | "subagent",
  parentSessionId?: string,
): DeclarationRow[] {
  const rows = database
    .query(
      `SELECT payload, at, uid, id FROM events
        WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ?
          AND json_extract(payload, '$.scope') = ?
        ORDER BY at ASC, uid ASC, id ASC`,
    )
    .all(sessionId, scope) as { payload: string; at: string; uid: string | null; id: number }[];
  return rows
    .map((row) => ({ at: row.at, uid: row.uid, id: row.id, payload: JSON.parse(row.payload) }))
    .filter(
      (row: DeclarationRow) =>
        scope !== "subagent" || row.payload.parent_session_id === parentSessionId,
    );
}

function coveredIntervals(
  database: Database,
  input: {
    sessionId: string;
    at: string;
    scope: "session" | "subagent";
    parentSessionId?: string;
  },
): CoverageInterval[] {
  const intervals = foldCoverage(
    readDeclarations(database, input.sessionId, input.scope, input.parentSessionId),
  );
  const sessionStart = sessionStartedAt(database, input.sessionId);
  return intervals.filter(
    (interval) =>
      resolveCoverageStart(interval, sessionStart) <= input.at &&
      (interval.end === null || input.at < interval.end),
  );
}

/** The plan in force at `at`: the latest amendment by then, else the first declaration's. */
function planAt(interval: CoverageInterval, at: string): string[] {
  let plan = interval.versions[0]?.plan ?? [];
  for (const version of interval.versions) if (version.at <= at) plan = version.plan;
  return plan;
}

/** The latest declaration time at or before `at`, else the first one (a back-covered stretch). */
function declaredKey(interval: CoverageInterval, at: string): string {
  let key = interval.versions[0]?.at ?? interval.declaredAt;
  for (const version of interval.versions) if (version.at <= at) key = version.at;
  return key;
}

function resolveDeclaration(
  database: Database,
  sessionId: string,
  scope: "session" | "subagent",
  at: string,
  parentSessionId?: string,
): DeclaredQuest | null {
  const rows = database
    .query(
      `SELECT payload FROM events
        WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ? AND at <= ?
        ORDER BY at DESC, uid DESC, id DESC`,
    )
    .all(sessionId, at) as { payload: string }[];

  const live = (questId: string) =>
    database
      .query("SELECT title, outcome FROM quests WHERE id = ? AND retracted_at IS NULL")
      .get(questId) as { title: string; outcome: string | null } | null;

  // Coverage first: the quest declared at `at`, even when its declaration is
  // later than `at` (a declaration covers the session from its start) or an
  // earlier one has been ended. The legacy "latest event" lookup below answers
  // only when nothing covers `at`.
  const covering = coveredIntervals(database, { sessionId, at, scope, parentSessionId })
    .map((interval, index) => ({ interval, index }))
    .sort(
      (left, right) =>
        declaredKey(right.interval, at).localeCompare(declaredKey(left.interval, at)) ||
        right.index - left.index,
    );
  for (const { interval } of covering) {
    const quest = live(interval.questId);
    if (!quest) continue;
    return {
      questId: interval.questId,
      title: quest.title,
      outcome: quest.outcome,
      plan: planAt(interval, at),
      scope,
      parentSessionId: scope === "subagent" ? (parentSessionId ?? null) : null,
    };
  }

  for (const row of rows) {
    const payload = JSON.parse(row.payload) as {
      session_id: string;
      quest_id?: string;
      scope: string;
      parent_session_id?: string;
      plan: string[];
    };
    if (payload.scope !== scope) continue;
    if (scope === "session" && payload.session_id !== sessionId) continue;
    if (
      scope === "subagent" &&
      (payload.session_id !== sessionId || payload.parent_session_id !== parentSessionId)
    ) {
      continue;
    }

    const questId = payload.quest_id;
    if (!questId) continue;
    const quest = live(questId);
    if (!quest) continue;
    return {
      questId,
      title: quest.title,
      outcome: quest.outcome,
      plan: payload.plan,
      scope: payload.scope as "session" | "subagent",
      parentSessionId: payload.parent_session_id ?? null,
    };
  }
  return null;
}

/**
 * A quest a session declared and has not ended, with the alias the verifier
 * names it by. Aliases are assigned fresh over the surviving set on every call,
 * exactly as `buildWindow` assigns stint aliases -- never persisted, never
 * carried across calls.
 */
export interface ActiveDeclaredQuest extends DeclaredQuest {
  alias: string;
}

/**
 * Every quest declared for a session at `at`.
 *
 * Coverage rule -- a declaration covers the session from its start, unless told
 * otherwise:
 *
 * - The FIRST declaration of a session (per scope) is active from the session's
 *   start (`claude_sessions.started_at`), not from its own event: models declare
 *   late, often at the end, and the work before that was still done for it.
 * - A later declaration starts at its own event, EXCEPT when every previously
 *   declared quest has been ended with `--done` by then: it then starts where
 *   the last `--done` happened, so there is no gap.
 * - `--since <iso>` (payload `since`, never after the event) overrides the
 *   computed start of the declaration that carries it.
 * - A quest is active until its own `--done`. Re-declaring an active quest only
 *   amends its plan (the plan at `at` is the latest amendment by then, or the
 *   first declaration's for a stretch before any), and a declaration made again
 *   after its `--done` opens a new stretch by the same rules.
 * - A session with no stored row has no start to reach back to, so its first
 *   declaration covers from its own event.
 * - Subagent-scope declarations follow the same rules within the subagent's own
 *   session, keyed by the pair (session, parent).
 *
 * `sessionHasActiveDeclaration`, `currentDeclaredQuest*` and
 * `latestDeclaredParentSessionId` answer from this same coverage, so they agree
 * with it. A session legitimately pursues several quests at once, so "latest
 * wins" (`currentDeclaredQuest`) cannot express what is actually declared.
 */
export function activeDeclaredQuests(
  database: Database,
  input: {
    sessionId: string;
    at: string;
    /**
     * Which declarations to fold. Defaults to `"session"`, the multi-quest case
     * this function exists for. `"subagent"` additionally requires
     * `parentSessionId`: a subagent's declarations are keyed by the pair, so
     * folding them without it would mix in another parent's.
     */
    scope?: "session" | "subagent";
    parentSessionId?: string;
  },
): ActiveDeclaredQuest[] {
  const scope = input.scope ?? "session";
  const result: ActiveDeclaredQuest[] = [];
  let aliasNumber = 0;
  for (const interval of coveredIntervals(database, { ...input, scope })) {
    const quest = database
      .query("SELECT title, outcome FROM quests WHERE id = ? AND retracted_at IS NULL")
      .get(interval.questId) as { title: string; outcome: string | null } | null;
    if (!quest) continue;
    aliasNumber += 1;
    result.push({
      questId: interval.questId,
      title: quest.title,
      outcome: quest.outcome,
      plan: planAt(interval, input.at),
      scope,
      parentSessionId: scope === "subagent" ? (input.parentSessionId ?? null) : null,
      alias: `Q${aliasNumber}`,
    });
  }
  return result;
}

export function currentDeclaredQuest(
  database: Database,
  input: { sessionId: string; at: string },
): DeclaredQuest | null {
  return resolveDeclaration(database, input.sessionId, "session", input.at);
}

export function currentDeclaredQuestForSubagent(
  database: Database,
  input: { sessionId: string; parentSessionId: string; at: string },
): DeclaredQuest | null {
  return resolveDeclaration(database, input.sessionId, "subagent", input.at, input.parentSessionId);
}

export function hasAnyDeclaration(database: Database, sessionId: string): boolean {
  const row = database
    .query(
      `SELECT 1 FROM events
        WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ?
        LIMIT 1`,
    )
    .get(sessionId);
  return row !== null;
}

/**
 * The `parent_session_id` on the session's latest declaration at `at`, or null
 * when that declaration is session-scoped (or there is none). Parent linkage
 * lives entirely on the `quest.declared` payload -- no schema or collector
 * column -- and `activeDeclaredQuests`/`currentDeclaredQuest` only resolve
 * session-scope declarations, so a subagent's parent has to be read from here.
 * When no declaration is at or before `at`, the session's first declaration
 * answers if its coverage reaches back over `at` (a subagent that declared late
 * is still the parent's child for the stretch before).
 */
export function latestDeclaredParentSessionId(
  database: Database,
  sessionId: string,
  at: string,
): string | null {
  const row = database
    .query(
      `SELECT payload FROM events
        WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ? AND at <= ?
        ORDER BY at DESC, uid DESC, id DESC LIMIT 1`,
    )
    .get(sessionId, at) as { payload: string } | null;
  if (row !== null) {
    const payload = JSON.parse(row.payload) as { scope?: string; parent_session_id?: string };
    if (payload.scope !== "subagent") return null;
    return payload.parent_session_id ?? null;
  }
  const first = database
    .query(
      `SELECT payload FROM events
        WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ?
        ORDER BY at ASC, uid ASC, id ASC LIMIT 1`,
    )
    .get(sessionId) as { payload: string } | null;
  if (first === null) return null;
  const payload = JSON.parse(first.payload) as { scope?: string; parent_session_id?: string };
  if (payload.scope !== "subagent" || !payload.parent_session_id) return null;
  const covered = coveredIntervals(database, {
    sessionId,
    at,
    scope: "subagent",
    parentSessionId: payload.parent_session_id,
  });
  return covered.length > 0 ? payload.parent_session_id : null;
}

/**
 * Whether the session has a quest declared and not ended at `at`, resolved
 * exactly as `buildWindow` resolves it (the parent id from the latest
 * declaration first, then the subagent's own quest or the parent's active
 * ones; a plain session's own active quests otherwise). This is what decides
 * that a window needs no `declare` question, so everything that must agree with
 * it -- the hook's `declare` hand-back, the run that promotes a `declare`
 * question -- asks this one function instead of re-deriving it.
 */
export function sessionHasActiveDeclaration(
  database: Database,
  input: { sessionId: string; at: string },
): boolean {
  const parentSessionId = latestDeclaredParentSessionId(database, input.sessionId, input.at);
  if (parentSessionId === null) {
    return activeDeclaredQuests(database, { sessionId: input.sessionId, at: input.at }).length > 0;
  }
  return (
    currentDeclaredQuestForSubagent(database, {
      sessionId: input.sessionId,
      parentSessionId,
      at: input.at,
    }) !== null ||
    activeDeclaredQuests(database, { sessionId: parentSessionId, at: input.at }).length > 0
  );
}

/**
 * Whether the session ever declared a quest, including one it later ended with
 * `--done` and including a subagent's declaration or its parent's. A
 * declaration whose quest was retracted does not count: it never happened as
 * far as every report is concerned. Used by `tempad review`, which looks back
 * at sessions that may long since have ended their quests; the live hook uses
 * `sessionHasActiveDeclaration` instead.
 */
export function sessionEverDeclared(database: Database, sessionId: string): boolean {
  const sessionIds = new Set([sessionId]);
  const rows = database
    .query(
      `SELECT payload FROM events
        WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ?`,
    )
    .all(sessionId) as { payload: string }[];
  for (const row of rows) {
    const parent = (JSON.parse(row.payload) as { parent_session_id?: string }).parent_session_id;
    if (parent) sessionIds.add(parent);
  }
  const placeholders = [...sessionIds].map(() => "?").join(", ");
  const declared = database
    .query(
      `SELECT 1 FROM events
         JOIN quests ON quests.id = json_extract(events.payload, '$.quest_id')
        WHERE events.kind = 'quest.declared'
          AND json_extract(events.payload, '$.session_id') IN (${placeholders})
          AND quests.retracted_at IS NULL
        LIMIT 1`,
    )
    .get(...sessionIds);
  return declared !== null;
}
