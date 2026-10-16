import type { Database } from "bun:sqlite";
import {
  type ActiveDeclaredQuest,
  activeDeclaredQuests,
  currentDeclaredQuestForSubagent,
} from "../intent/declarations";
import { type ClassifierWindow, type DeclaredQuestSlice, planAliasPrefix } from "./classifier";

export function findSessionFile(database: Database, sessionId: string): string | null {
  const row = database
    .query("SELECT file_path FROM claude_sessions WHERE id = ?")
    .get(sessionId) as { file_path: string } | null;
  return row?.file_path ?? null;
}

export interface BuildWindowInput {
  sessionId: string;
  sinceTs: string | null;
  maxMessages: number;
  memoryHours: number;
  memoryStints: number;
  overlapMessages: number;
  /**
   * The last message timestamp of the window being classified. Candidate
   * stints must have opened strictly before it: backfill walks history, so
   * without this bound a window on Sept 1 is offered stints opened on Sept 3
   * by a session processed earlier, the classifier matches them, and the traces
   * it records land before their stint's `opened_at` -- negative durations,
   * and a `continues` link that can never fire. Omitted (or null) means "now",
   * which is what a live run wants: nothing in the database is in its future.
   */
  windowEnd?: string | null;
  /**
   * `"inferred"` restores the pre-verifier slice: the quest lists the classifier
   * used to browse come back and no declaration is looked up. Defaults to
   * `"declared"`.
   */
  mode?: "declared" | "inferred";
}

interface StintRow {
  stintId: string;
  what: string;
  why: string;
  questId: string | null;
  questTitle: string | null;
  openedAt: string;
  lastTraceEndedAt: string;
}

/**
 * A stint plus the `what`/`why` of its latest live trace and its last trace's
 * `ended_at`. `traces.session_id` decides which session a stint belongs to.
 */
const ACTIVITY_SLICE_SELECT = `
  SELECT stints.id as stintId,
         latest.what as what,
         latest.why as why,
         stints.quest_id as questId,
         quests.title as questTitle,
         stints.opened_at as openedAt,
         latest.ended_at as lastTraceEndedAt,
         stints.closed_at as closedAt,
         stints.close_reason as closeReason
    FROM stints
    JOIN traces latest ON latest.id = (
           SELECT traces.id FROM traces
            WHERE traces.stint_id = stints.id AND traces.retracted_at IS NULL
            ORDER BY traces.ended_at DESC LIMIT 1)
    LEFT JOIN quests ON quests.id = stints.quest_id AND quests.retracted_at IS NULL
   WHERE stints.retracted_at IS NULL
     AND stints.dismissed_at IS NULL`;

/**
 * The `parent_session_id` on the session's latest declaration at `at`, or null
 * when its latest declaration is session-scoped (or there is none). Parent
 * linkage lives entirely on the `quest.declared` payload -- no schema or
 * collector column -- so this is the only place it needs to be read.
 */
function latestDeclaredParentSessionId(
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
  const payload = JSON.parse(row.payload) as {
    scope?: string;
    parent_session_id?: string;
  };
  if (payload.scope !== "subagent") return null;
  return payload.parent_session_id ?? null;
}

/**
 * Aliases are assigned fresh here, never persisted: `activeDeclaredQuests`
 * numbers the session's own quests `Q1..Qn`, and a parent's are re-lettered
 * `PQ1..PQn` so the two spaces can be offered together without colliding.
 */
function toAliasedSlices(
  active: ActiveDeclaredQuest[],
  prefix: "Q" | "PQ",
): {
  quests: (DeclaredQuestSlice & { alias: string })[];
  aliases: Record<string, string>;
} {
  const quests: (DeclaredQuestSlice & { alias: string })[] = [];
  const aliases: Record<string, string> = {};
  for (const [index, quest] of active.entries()) {
    const alias = `${prefix}${index + 1}`;
    aliases[alias] = quest.questId;
    quests.push({ alias, title: quest.title, outcome: quest.outcome, plan: quest.plan });
  }
  return { quests, aliases };
}

export function buildWindow(database: Database, input: BuildWindowInput): ClassifierWindow {
  const session = database
    .query(
      "SELECT title, cwd, git_branch as gitBranch, org, project, started_at as startedAt FROM claude_sessions WHERE id = ?",
    )
    .get(input.sessionId) as {
    title: string | null;
    cwd: string | null;
    gitBranch: string | null;
    org: string;
    project: string;
    startedAt: string | null;
  } | null;

  if (!session) {
    throw new Error(`unknown claude session: ${input.sessionId}`);
  }

  const messageRows =
    input.sinceTs !== null
      ? (database
          .query(
            `SELECT ts, role, text_preview as text FROM claude_messages
             WHERE session_id = ? AND ts > ? AND text_preview IS NOT NULL
             ORDER BY ts ASC`,
          )
          .all(input.sessionId, input.sinceTs) as { ts: string; role: string; text: string }[])
      : (
          database
            .query(
              `SELECT ts, role, text_preview as text FROM claude_messages
             WHERE session_id = ? AND text_preview IS NOT NULL
             ORDER BY ts DESC LIMIT ?`,
            )
            .all(input.sessionId, input.maxMessages) as { ts: string; role: string; text: string }[]
        ).reverse();

  const messages = input.sinceTs !== null ? messageRows.slice(-input.maxMessages) : messageRows;

  const mode = input.mode ?? "declared";

  const openQuests =
    mode === "inferred"
      ? (database
          .query(
            `SELECT quests.id as id, quests.title as title, quests.outcome as outcome,
              (SELECT MAX(traces.started_at) FROM traces
                 JOIN stints ON stints.id = traces.stint_id
                WHERE stints.quest_id = quests.id) as lastStintAt
         FROM quests
        WHERE quests.state IN ('started', 'resumed')
          AND quests.merged_into IS NULL
          AND quests.retracted_at IS NULL
          AND (
            quests.owner_kind = 'hero'
            OR quests.owner_id IN (SELECT id FROM parties WHERE slug = ?)
          )`,
          )
          .all(session.org) as {
          id: string;
          title: string;
          outcome: string | null;
          lastStintAt: string | null;
        }[])
      : undefined;

  // A stint opened after this window ended did not exist yet when the window
  // happened, so it is never a candidate -- see `windowEnd` on `BuildWindowInput`.
  const windowEnd = input.windowEnd ?? new Date().toISOString();

  const sessionOpenStints = database
    .query(
      `${ACTIVITY_SLICE_SELECT}
         AND stints.closed_at IS NULL
         AND stints.opened_at < ?
         AND latest.session_id = ?
       ORDER BY stints.opened_at ASC`,
    )
    .all(windowEnd, input.sessionId) as (StintRow & {
    closedAt: string | null;
    closeReason: string | null;
  })[];

  // The reference time for "recent": where this window starts, so backfill windows
  // see the same slice a live run would have seen at that point in the session.
  const referenceTime = input.sinceTs ?? session.startedAt ?? new Date().toISOString();
  const memoryCutoff = new Date(
    Date.parse(referenceTime) - input.memoryHours * 60 * 60 * 1000,
  ).toISOString();

  // Closed stints of *this* session belong here too: an idle gap mid-session
  // closes a stint, and returning to it afterwards is exactly a `continues`
  // link. Still-open ones are already in `sessionOpenActivities`, so no stint
  // appears in both slices.
  const recentStints = database
    .query(
      `${ACTIVITY_SLICE_SELECT}
         AND stints.opened_at < ?
         AND (stints.closed_at IS NULL OR stints.closed_at >= ?)
         AND (stints.opened_at >= ? OR stints.closed_at >= ?)
         AND (latest.session_id != ? OR stints.closed_at IS NOT NULL)
         AND latest.place = ?
       ORDER BY COALESCE(stints.closed_at, stints.opened_at) DESC
       LIMIT ?`,
    )
    .all(
      windowEnd,
      memoryCutoff,
      memoryCutoff,
      memoryCutoff,
      input.sessionId,
      `${session.org}/${session.project}`,
      input.memoryStints,
    ) as (StintRow & { closedAt: string | null; closeReason: string | null })[];

  const recentSideQuests =
    mode === "inferred"
      ? (database
          .query(
            `SELECT quests.id as id, quests.title as title, quests.trigger as trigger
         FROM quests
        WHERE quests.deviates_from_stint_id IS NOT NULL
          AND quests.trigger IS NOT NULL
          AND quests.retracted_at IS NULL
          AND (
            quests.owner_kind = 'hero'
            OR quests.owner_id IN (SELECT id FROM parties WHERE slug = ?)
          )
        ORDER BY quests.branched_at DESC
        LIMIT 3`,
          )
          .all(session.org) as { id: string; title: string; trigger: string }[])
      : undefined;

  // Only a window with a cut has messages "before" it. A whole-session window
  // (sinceTs null, as backfill builds) starts at the session's first message, so
  // there is no tail to carry and nothing may be marked as context-only.
  const overlapMessages =
    input.sinceTs === null || input.overlapMessages <= 0
      ? []
      : (
          database
            .query(
              `SELECT ts, role, text_preview as text FROM claude_messages
                WHERE session_id = ? AND ts <= ? AND text_preview IS NOT NULL
                ORDER BY ts DESC LIMIT ?`,
            )
            .all(input.sessionId, input.sinceTs, input.overlapMessages) as {
            ts: string;
            role: string;
            text: string;
          }[]
        ).reverse();

  const runRow = database
    .query("SELECT session_note FROM w5_runs WHERE session_id = ?")
    .get(input.sessionId) as { session_note: string | null } | null;

  // The declaration is resolved at the window's own reference time, so a backfill
  // window sees what was declared when it happened, not what is declared now. A
  // subagent's own declaration carries its parent's session id, which is the only
  // thing needed to find the parent's quest -- no schema or collector change.
  let activeQuests: (DeclaredQuestSlice & { alias: string })[] = [];
  let activeQuestAliases: Record<string, string> = {};
  let parentActiveQuests: (DeclaredQuestSlice & { alias: string })[] = [];
  let parentActiveQuestAliases: Record<string, string> = {};
  if (mode === "declared") {
    // `activeDeclaredQuests` only ever resolves *session*-scope declarations, so
    // a subagent's own quest is invisible to it. The parent id is read straight
    // off the latest declaration event -- the same place the resolver reads it --
    // and then the subagent resolver is asked for the quest itself. A subagent
    // still declares exactly one quest, rendered through the same list shape.
    const parentSessionId = latestDeclaredParentSessionId(database, input.sessionId, windowEnd);
    if (parentSessionId !== null) {
      const own = currentDeclaredQuestForSubagent(database, {
        sessionId: input.sessionId,
        parentSessionId,
        at: windowEnd,
      });
      const ownAliased = toAliasedSlices(own === null ? [] : [{ ...own, alias: "Q1" }], "Q");
      activeQuests = ownAliased.quests;
      activeQuestAliases = ownAliased.aliases;
      const parentAliased = toAliasedSlices(
        activeDeclaredQuests(database, { sessionId: parentSessionId, at: windowEnd }),
        "PQ",
      );
      parentActiveQuests = parentAliased.quests;
      parentActiveQuestAliases = parentAliased.aliases;
    } else {
      const aliased = toAliasedSlices(
        activeDeclaredQuests(database, { sessionId: input.sessionId, at: windowEnd }),
        "Q",
      );
      activeQuests = aliased.quests;
      activeQuestAliases = aliased.aliases;
    }
  }

  // A plan item is prompt-only until a segment names it, so this map is built
  // from the declarations themselves and never read back from `stints`.
  const planAliases: Record<string, string> = {};
  for (const quest of [...activeQuests, ...parentActiveQuests]) {
    for (const [index, item] of quest.plan.entries()) {
      planAliases[`${planAliasPrefix(quest.alias)}.${index + 1}`] = item;
    }
  }

  const openSlice = sessionOpenStints.map(
    ({ closedAt: _closedAt, closeReason: _closeReason, ...stint }) => stint,
  );

  // Aliases are assigned over both slices in the order they are listed, so the
  // prompt never carries a 26-character id for the model to garble; `apply.ts`
  // maps whatever alias comes back through `openStintAliases`.
  // Inference mode is the pre-verifier path end to end: `apply.ts` looks stint
  // ids up directly there, so the slice must keep carrying real ids. Aliasing is
  // declared mode's scheme alone.
  const openStintAliases: Record<string, string> = {};
  let aliasNumber = 0;
  const aliasFor = (realId: string): string => {
    if (mode !== "declared") return realId;
    aliasNumber += 1;
    const alias = `S${aliasNumber}`;
    openStintAliases[alias] = realId;
    return alias;
  };

  const aliasedOpen = openSlice.map((stint) => ({
    ...stint,
    stintId: aliasFor(stint.stintId),
  }));
  const aliasedRecent = recentStints.map((stint) => ({
    ...stint,
    stintId: aliasFor(stint.stintId),
  }));

  return {
    sessionId: input.sessionId,
    title: session.title,
    cwd: session.cwd,
    gitBranch: session.gitBranch,
    org: session.org,
    project: session.project,
    messages,
    mode,
    activeQuests,
    activeQuestAliases,
    parentActiveQuests,
    parentActiveQuestAliases,
    openStintAliases,
    planAliases,
    ...(openQuests === undefined ? {} : { openQuests }),
    sessionOpenStints: aliasedOpen,
    recentStints: aliasedRecent,
    ...(recentSideQuests === undefined ? {} : { recentSideQuests }),
    overlapMessages,
    previousSessionNote: runRow?.session_note ?? null,
  };
}
