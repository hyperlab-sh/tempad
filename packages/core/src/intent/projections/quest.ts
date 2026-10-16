import type { Database } from "bun:sqlite";
import { resolveOwnerIdentity } from "../identity";
import type { Projection } from "./index";

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
      branched_at TEXT,
      trigger TEXT,
      branch_kind TEXT,
      returned_at TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      replaced_by TEXT,
      retracted_at TEXT
    );`,
  apply(database, event) {
    const payload = event.payload;
    switch (event.kind) {
      case "quest.created": {
        const owner = resolveOwnerIdentity(database, payload.owner as { kind: string; id: string });
        database
          .query(
            `INSERT OR REPLACE INTO quests
              (id, owner_kind, owner_id, serves, title, outcome, done_condition, due, budget_minutes, commitment, confirmed, origin_kind, revision, state, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'started', ?)`,
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
          );
        return;
      }
      case "quest.reworded":
        database
          .query(
            "UPDATE quests SET title = COALESCE(?, title), outcome = COALESCE(?, outcome), revision = revision + 1 WHERE id = ?",
          )
          .run(
            payload.title !== undefined ? String(payload.title) : null,
            payload.outcome !== undefined ? String(payload.outcome) : null,
            event.subject,
          );
        return;
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
      case "quest.branched":
        database
          .query(
            "UPDATE quests SET deviates_from_stint_id = ?, branched_at = ?, trigger = ?, branch_kind = ? WHERE id = ?",
          )
          .run(
            String(payload.deviates_from),
            String(payload.at ?? event.at),
            String(payload.trigger),
            String(payload.kind),
            event.subject,
          );
        return;
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
