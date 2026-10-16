import type { Database } from "bun:sqlite";
import { listProjections } from "../intent/projections";
import { registerAllProjections } from "../intent/projections/register";
import { stateAsOf } from "../intent/time-travel";

registerAllProjections();

export interface ProjectionDifference {
  table: string;
  stored: number;
  replayed: number;
  /** Rows the replay produces that the stored table lacks. */
  missing: number;
  /** Rows the stored table holds that the replay does not produce. */
  extra: number;
  /** The stored database has no such table at all. */
  tableMissing: boolean;
  /** Columns the replayed table has and the stored one lacks. */
  columnsMissing: string[];
  /** Columns the stored table has and the replayed one lacks. */
  columnsExtra: string[];
}

/** Later than any `at` an event can carry, so `stateAsOf` replays the whole log. */
const END_OF_TIME = "9999-12-31T23:59:59.999Z";

function tableColumns(database: Database, table: string): string[] {
  return (
    database.query("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(table) as {
      name: string;
    }[]
  ).map((row) => row.name);
}

/** Each row as a JSON array of its values in `columns` order; the multiset is what gets compared. */
function rowCounts(database: Database, table: string, columns: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (columns.length === 0) return counts;
  const rows = database
    .query(`SELECT ${columns.map((column) => `"${column}"`).join(", ")} FROM "${table}"`)
    .values();
  for (const row of rows) {
    const key = JSON.stringify(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function multisetDifference(left: Map<string, number>, right: Map<string, number>): number {
  let difference = 0;
  for (const [key, count] of left) difference += Math.max(0, count - (right.get(key) ?? 0));
  return difference;
}

/**
 * Replays the whole event log into a throwaway in-memory database
 * (`stateAsOf`, the same path `tempad rebuild` takes) and compares every
 * projection table with the stored one: the table must exist, have the same
 * columns, and hold the same rows. Read-only on `database`. A stored table
 * that does not exist counts as empty (and is reported as missing even when
 * the replay is empty too), so a log whose projections were never built, or a
 * dropped table, cannot pass. Returns the tables that differ; empty means the
 * projections match the log.
 */
export function compareProjectionsToReplay(database: Database): ProjectionDifference[] {
  const replayed = stateAsOf(database, END_OF_TIME);
  try {
    const differences: ProjectionDifference[] = [];
    for (const projection of listProjections()) {
      for (const table of projection.tables) {
        const replayColumns = tableColumns(replayed, table);
        const storedColumns = tableColumns(database, table);
        const tableMissing = storedColumns.length === 0;
        const columnsMissing = tableMissing
          ? []
          : replayColumns.filter((column) => !storedColumns.includes(column));
        const columnsExtra = storedColumns.filter((column) => !replayColumns.includes(column));
        // Rows are compared over the columns both sides have, in the replay's order.
        const columns = replayColumns.filter((column) => storedColumns.includes(column));
        const stored = rowCounts(database, table, columns);
        const expected = rowCounts(replayed, table, columns);
        const missing = multisetDifference(expected, stored);
        const extra = multisetDifference(stored, expected);
        if (
          !tableMissing &&
          columnsMissing.length === 0 &&
          columnsExtra.length === 0 &&
          missing === 0 &&
          extra === 0
        )
          continue;
        differences.push({
          table,
          stored: [...stored.values()].reduce((sum, count) => sum + count, 0),
          replayed: [...expected.values()].reduce((sum, count) => sum + count, 0),
          missing,
          extra,
          tableMissing,
          columnsMissing,
          columnsExtra,
        });
      }
    }
    return differences;
  } finally {
    replayed.close();
  }
}
