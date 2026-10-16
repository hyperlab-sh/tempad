import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { ALL_PROJECTIONS } from "../../src/intent/projections/register";
import {
  LOCAL_ONLY_TABLES,
  SYNCED_APPEND_TABLES,
  SYNCED_UPSERT_TABLES,
} from "../../src/sync/tables";

function schemaTables(): string[] {
  const database = openDatabase(":memory:");
  // The production projections' own DDL, not the global registry: other test
  // files in the same process register throwaway projections into it.
  for (const projection of ALL_PROJECTIONS) database.exec(projection.createSql);
  const names = (
    database
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  database.close();
  return names;
}

const classified = [
  ...SYNCED_APPEND_TABLES.map((table) => table.name),
  ...SYNCED_UPSERT_TABLES.map((table) => table.name),
  ...LOCAL_ONLY_TABLES,
];

describe("sync table registry", () => {
  test("every table in a migrated database, projections included, is classified", () => {
    const unclassified = schemaTables().filter((name) => !classified.includes(name));
    expect(unclassified).toEqual([]);
  });

  test("every table is in exactly one list", () => {
    const counts = new Map<string, number>();
    for (const name of classified) counts.set(name, (counts.get(name) ?? 0) + 1);
    expect([...counts].filter(([, count]) => count > 1)).toEqual([]);
  });

  test("the registry names no table the schema lacks", () => {
    const tables = schemaTables();
    expect(classified.filter((name) => !tables.includes(name))).toEqual([]);
  });

  test("key columns are the real primary key of each synced-upsert table", () => {
    const database = openDatabase(":memory:");
    for (const table of SYNCED_UPSERT_TABLES) {
      const primaryKey = (
        database
          .query(`SELECT name, pk FROM pragma_table_info('${table.name}') WHERE pk > 0 ORDER BY pk`)
          .all() as { name: string }[]
      ).map((column) => column.name);
      expect(primaryKey).toEqual([...table.keyColumns]);
    }
    database.close();
  });

  test("push order puts every parent before the children that reference it", () => {
    const database = openDatabase(":memory:");
    const order = SYNCED_UPSERT_TABLES.map((table) => table.name);
    for (const table of order) {
      const parents = (
        database
          .query(`SELECT "table" AS parent FROM pragma_foreign_key_list('${table}')`)
          .all() as {
          parent: string;
        }[]
      ).map((row) => row.parent);
      for (const parent of parents) {
        expect(order).toContain(parent);
        expect(order.indexOf(parent)).toBeLessThan(order.indexOf(table));
      }
    }
    database.close();
  });
});
