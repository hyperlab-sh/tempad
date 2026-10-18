import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import * as migrationFiles from "../src/db/migration-files.ts";

describe("openDatabase", () => {
  test("opening twice is idempotent, user_version is 23, tables exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-db-test-"));
    const dbPath = join(dir, "tempad.db");

    try {
      const first = openDatabase(dbPath);
      first.close();

      const second = openDatabase(dbPath);

      const version = (second.query("PRAGMA user_version;").get() as { user_version: number })
        .user_version;
      expect(version).toBe(26);

      const tableNames = (
        second.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name);

      expect(tableNames).toEqual(
        expect.arrayContaining([
          "sync_state",
          "monday_items",
          "gh_repos",
          "gh_commits",
          "gh_pull_requests",
          "claude_sessions",
          "claude_messages",
        ]),
      );

      const foreignKeys = (second.query("PRAGMA foreign_keys;").get() as { foreign_keys: number })
        .foreign_keys;
      expect(foreignKeys).toBe(1);

      const journalMode = (second.query("PRAGMA journal_mode;").get() as { journal_mode: string })
        .journal_mode;
      expect(journalMode).toBe("wal");

      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openDatabase when a migration throws", () => {
  const cases = [
    { name: "before the trigger gate", versions: [1], bad: 1 },
    { name: "from the trigger gate on", versions: [], bad: 24 },
  ];
  for (const { name, versions, bad } of cases) {
    test(`closes the handle and rethrows (${name})`, () => {
      const dir = mkdtempSync(join(tmpdir(), "tempad-db-test-"));
      const dbPath = join(dir, "tempad.db");
      const real = migrationFiles.loadMigrations();
      const chain = [
        ...(versions.length === 0 ? real : []),
        { version: bad, sql: "THIS IS NOT SQL;" },
      ];
      const load = spyOn(migrationFiles, "loadMigrations").mockImplementation(() => chain);
      const close = spyOn(Database.prototype, "close");
      try {
        expect(() => openDatabase(dbPath)).toThrow();
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        close.mockRestore();
        load.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
