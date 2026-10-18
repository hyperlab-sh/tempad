import type { Database } from "bun:sqlite";
import { resolveOwnerIdentity } from "../identity";
import { judgeTitleQuality, openQuestTitles, type TitleVerdict } from "../title-quality";
import type { Projection } from "./index";

/** Columns the title-quality verdict lives in (see `title-quality.ts`). */
function titleVerdictColumns(verdict: TitleVerdict): { flag: 0 | 1; reason: string | null } {
  if (verdict.verdict === "ok") return { flag: 0, reason: null };
  return { flag: 1, reason: verdict.reason };
}

export const questProjection: Projection = {
  name: "quests",
  tables: ["quests"],
  createSql: `
    CREATE TABLE IF NOT EXISTS quests (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      serves TEXT,
      title TEXT NOT NULL,
      outcome TEXT,
      done_condition TEXT,
      due TEXT,
      budget_minutes INTEGER,
      commitment TEXT,
      origin_kind TEXT NOT NULL DEFAULT 'inferred',
      confirmed INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'started',
      state_reason TEXT,
      merged_into TEXT,
      deviates_from_stint_id TEXT,
      deviates_from_quest_id TEXT,
      branched_at TEXT,
      trigger TEXT,
      branch_kind TEXT,
      returned_at TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      replaced_by TEXT,
      retracted_at TEXT,
      title_vague INTEGER NOT NULL DEFAULT 0,
      title_vague_reason TEXT
    );`,
  apply(database, event) {
    const payload = event.payload;
    switch (event.kind) {
      case "quest.created": {
        const owner = resolveOwnerIdentity(database, payload.owner as { kind: string; id: string });
        // Judged against the open quests as of this event -- a rebuild replays
        // events in order, so a duplicate target created earlier is in the table
        // and one ended later is not yet ended, reproducing the original
        // verdict without storing it on the event.
        const verdict = judgeTitleQuality(String(payload.title), openQuestTitles(database));
        const vague = titleVerdictColumns(verdict);
        database
          .query(
            `INSERT OR REPLACE INTO quests
              (id, owner_kind, owner_id, serves, title, outcome, done_condition, due, budget_minutes, commitment, confirmed, origin_kind, revision, state, created_at, title_vague, title_vague_reason)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'started', ?, ?, ?)`,
          )
          .run(
            event.subject,
            owner.kind,
            owner.id,
            payload.serves ? String(payload.serves) : null,
            String(payload.title),
            payload.outcome ? String(payload.outcome) : null,
            payload.done_condition ? String(payload.done_condition) : null,
            payload.due ? String(payload.due) : null,
            payload.budget_minutes !== undefined ? Number(payload.budget_minutes) : null,
            payload.commitment ? String(payload.commitment) : null,
            payload.confirmed === false ? 0 : 1,
            payload.origin_kind ? String(payload.origin_kind) : "inferred",
            event.at,
            vague.flag,
            vague.reason,
          );
        return;
      }
      case "quest.reworded": {
        // A reword is re-judged: an ok title clears the vague flag (the point
        // of the nudge), and a reword into another vague or duplicate title
        // records that instead. The quest itself is excluded from the
        // duplicate comparison -- it is about to carry the new title.
        if (payload.title !== undefined) {
          const vague = titleVerdictColumns(
            judgeTitleQuality(
              String(payload.title),
              openQuestTitles(database).filter((quest) => quest.id !== event.subject),
            ),
          );
          database
            .query(
              "UPDATE quests SET title = ?, outcome = COALESCE(?, outcome), revision = revision + 1, title_vague = ?, title_vague_reason = ? WHERE id = ?",
            )
            .run(
              String(payload.title),
              payload.outcome !== undefined ? String(payload.outcome) : null,
              vague.flag,
              vague.reason,
              event.subject,
            );
          return;
        }
        database
          .query(
            "UPDATE quests SET outcome = COALESCE(?, outcome), revision = revision + 1 WHERE id = ?",
          )
          .run(payload.outcome !== undefined ? String(payload.outcome) : null, event.subject);
        return;
      }
      case "quest.ended":
        database
          .query("UPDATE quests SET ended_at = ?, end_reason = ?, replaced_by = ? WHERE id = ?")
          .run(
            event.at,
            payload.reason ? String(payload.reason) : null,
            payload.replaced_by ? String(payload.replaced_by) : null,
            event.subject,
          );
        return;
      case "quest.confirmed":
        database.query("UPDATE quests SET confirmed = 1 WHERE id = ?").run(event.subject);
        return;
      case "quest.merged": {
        // Two hosts can merge the same pair in opposite directions before
        // either sees the other (A: Q1 into Q2, B: Q2 into Q1). Replaying both
        // would close a loop that hides both quests and makes `resolveQuest`
        // throw on every CLI path. Replay order is uid order on every host, so
        // dropping the merge that would close the loop (the later one) keeps
        // the first and converges. A single host's CLI never emits such a
        // merge (it resolves both ids to their roots and refuses a self-merge),
        // so a single-host log is unchanged.
        const into = String(payload.into);
        if (mergeWouldCycle(database, event.subject, into)) return;
        database.query("UPDATE quests SET merged_into = ? WHERE id = ?").run(into, event.subject);
        return;
      }
      case "quest.lifecycle":
        database
          .query("UPDATE quests SET state = ?, state_reason = ? WHERE id = ?")
          .run(
            String(payload.state),
            payload.reason ? String(payload.reason) : null,
            event.subject,
          );
        return;
      case "quest.branched": {
        const relation = branchRelation(database, event.subject, event.at, payload);
        database
          .query(
            "UPDATE quests SET deviates_from_stint_id = ?, deviates_from_quest_id = ?, branched_at = ?, trigger = ?, branch_kind = ? WHERE id = ?",
          )
          .run(
            relation.stintId,
            relation.questId,
            String(payload.at ?? event.at),
            String(payload.trigger),
            String(payload.kind),
            relation.sideQuestId,
          );
        return;
      }
      case "quest.returned":
        database
          .query("UPDATE quests SET returned_at = ? WHERE id = ?")
          .run(event.at, event.subject);
        return;
      case "retracted":
        database
          .query("UPDATE quests SET retracted_at = ? WHERE id = ? AND retracted_at IS NULL")
          .run(event.at, event.subject);
        return;
      default:
        return;
    }
  },
};

/**
 * True when pointing `source` at `target` would make `source` reachable from
 * `target` by following `merged_into` (or `source` is `target`). A merge into a
 * quest that is itself merged away is fine: it chains, and `resolveQuest`
 * follows the chain.
 */
export function mergeWouldCycle(database: Database, source: string, target: string): boolean {
  let current = target;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    if (current === source) return true;
    visited.add(current);
    const row = database.query("SELECT merged_into FROM quests WHERE id = ?").get(current) as {
      merged_into: string | null;
    } | null;
    if (!row?.merged_into) return false;
    current = row.merged_into;
  }
  return false;
}

export function resolveQuest(database: Database, id: string): string {
  let current = id;
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(current)) {
      throw new Error(`quest merge cycle detected starting at ${id}`);
    }
    visited.add(current);
    const row = database.query("SELECT merged_into FROM quests WHERE id = ?").get(current) as {
      merged_into: string | null;
    } | null;
    if (!row?.merged_into) return current;
    current = row.merged_into;
  }
}

interface BranchRelation {
  /** The side quest: the row the relation is stored on. */
  sideQuestId: string;
  /** The stint it deviates from, when the event names one. */
  stintId: string | null;
  /** The quest it deviates from, when the event names a quest instead. */
  questId: string | null;
}

/**
 * Reads a `quest.branched` event in any of the three shapes the log holds.
 * `subject` is always the side quest except in the legacy declare shape.
 *
 * - `deviates_from_quest: <quest>`: the side quest (`subject`) deviates from a
 *   quest. `tempad quest declare --new ... --deviates-from|--origin` writes it,
 *   as does `quest branch` given a quest id. The distinct field name is the
 *   marker: no event written before it existed carries it.
 * - `deviates_from: <stint>`: the side quest deviates from a stint (`quest
 *   branch` with a stint id, the w5 classifier, `answer --origin current`).
 * - Legacy declare: before the marker existed, `declareQuest` wrote the pair
 *   inverted, `subject` = the quest left and `deviates_from` = the new side
 *   quest's id, in the same call that created it, so the side quest's
 *   `quest.created` carries the same `at`. That signature (`deviates_from` names
 *   a quest created at this event's `at`) is read as "that quest deviates from
 *   `subject`". A stint id never names a quest row, so a stint-shaped event is
 *   never mistaken for it.
 * - Any other `deviates_from` that names a quest (a hand-run `quest branch`
 *   that passed a quest id before it accepted one) is read as `subject`
 *   deviating from that quest, which is what the flag says.
 *
 * Only this projection's own table is consulted: `rebuildAll` replays every
 * event into one projection before the next, so the stints table is not
 * populated yet here.
 */
function branchRelation(
  database: Database,
  subject: string,
  at: string,
  payload: Record<string, unknown>,
): BranchRelation {
  if (typeof payload.deviates_from_quest === "string") {
    return { sideQuestId: subject, stintId: null, questId: payload.deviates_from_quest };
  }
  const from = typeof payload.deviates_from === "string" ? payload.deviates_from : null;
  if (from === null) return { sideQuestId: subject, stintId: null, questId: null };
  const quest = database.query("SELECT created_at FROM quests WHERE id = ?").get(from) as {
    created_at: string;
  } | null;
  if (quest === null) return { sideQuestId: subject, stintId: from, questId: null };
  if (quest.created_at === at && from !== subject) {
    return { sideQuestId: from, stintId: null, questId: subject };
  }
  return { sideQuestId: subject, stintId: null, questId: from };
}
