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
    if (input.newQuest.origin) {
      applyIncremental(
        database,
        store.append({
          actor: input.declaredBy === "hero" ? "hero" : "hook",
          kind: "quest.branched",
          subject: input.newQuest.origin,
          at: input.at,
          payload: {
            deviates_from: questId,
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
    const quest = database
      .query("SELECT title, outcome FROM quests WHERE id = ? AND retracted_at IS NULL")
      .get(questId) as { title: string; outcome: string | null } | null;
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
 * Every quest still active for a session at `at`. A `quest.declared` event marks
 * its quest active from `at` onward; one carrying `done: true` ends it. A session
 * legitimately pursues several quests at once, so "latest wins"
 * (`currentDeclaredQuest`) cannot express what is actually declared -- declaring
 * a second quest would silently retire the first.
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
  const rows = database
    .query(
      `SELECT payload, at FROM events
        WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = ?
          AND json_extract(payload, '$.scope') = ? AND at <= ?
        ORDER BY at ASC, uid ASC, id ASC`,
    )
    .all(input.sessionId, scope, input.at) as { payload: string; at: string }[];

  // Insertion order is declaration order, so a quest re-declared later to amend
  // its plan keeps its position and its alias does not jump around.
  const active = new Map<string, { plan: string[]; at: string }>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as {
      quest_id?: string;
      plan?: string[];
      done?: boolean;
      parent_session_id?: string;
    };
    if (scope === "subagent" && payload.parent_session_id !== input.parentSessionId) continue;
    const questId = payload.quest_id;
    if (!questId) continue;
    if (payload.done === true) {
      active.delete(questId);
      continue;
    }
    const existing = active.get(questId);
    if (existing) {
      existing.plan = payload.plan ?? [];
      existing.at = row.at;
      continue;
    }
    active.set(questId, { plan: payload.plan ?? [], at: row.at });
  }

  const result: ActiveDeclaredQuest[] = [];
  let aliasNumber = 0;
  for (const [questId, entry] of active) {
    const quest = database
      .query("SELECT title, outcome FROM quests WHERE id = ? AND retracted_at IS NULL")
      .get(questId) as { title: string; outcome: string | null } | null;
    if (!quest) continue;
    aliasNumber += 1;
    result.push({
      questId,
      title: quest.title,
      outcome: quest.outcome,
      plan: entry.plan,
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
  if (row === null) return null;
  const payload = JSON.parse(row.payload) as { scope?: string; parent_session_id?: string };
  if (payload.scope !== "subagent") return null;
  return payload.parent_session_id ?? null;
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
