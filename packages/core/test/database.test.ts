import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";

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
      expect(version).toBe(23);

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
