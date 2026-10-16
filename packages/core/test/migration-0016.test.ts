import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const MIGRATION_0016_SQL = readFileSync(join(MIGRATIONS_DIR, "0016_impacts_session.sql"), "utf8");

describe("migration 0016_impacts_session", () => {
  test("replays on a database that already has impacts rows with the three old kinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-migration-0016-test-"));
    const dbPath = join(dir, "tempad.db");

    try {
      const pre = new Database(dbPath);
      pre.exec(`
        CREATE TABLE impacts (
          subject TEXT PRIMARY KEY,
          subject_kind TEXT NOT NULL CHECK (subject_kind IN ('pr', 'commit', 'monday')),
          text TEXT NOT NULL,
          theme TEXT,
          revision INTEGER NOT NULL,
          stated_at TEXT NOT NULL,
          event_id INTEGER NOT NULL,
          retracted_at TEXT
        );
      `);
      pre.exec(
        `INSERT INTO impacts (subject, subject_kind, text, theme, revision, stated_at, event_id, retracted_at)
         VALUES
         ('commit:abc1234', 'commit', 'Fixed the crash', NULL, 1, '2026-09-01T00:00:00.000Z', 1, NULL),
         ('pr:acme/widgets#1', 'pr', 'Shipped the thing', 'feature', 1, '2026-09-01T00:00:00.000Z', 2, NULL),
         ('monday:99', 'monday', 'Improved onboarding', NULL, 1, '2026-09-01T00:00:00.000Z', 3, NULL)`,
      );

      pre.exec(MIGRATION_0016_SQL);

      const rows = pre
        .query("SELECT subject, subject_kind, text FROM impacts ORDER BY subject")
        .all() as { subject: string; subject_kind: string; text: string }[];
      expect(rows).toEqual([
        { subject: "commit:abc1234", subject_kind: "commit", text: "Fixed the crash" },
        { subject: "monday:99", subject_kind: "monday", text: "Improved onboarding" },
        { subject: "pr:acme/widgets#1", subject_kind: "pr", text: "Shipped the thing" },
      ]);

      pre.exec(
        `INSERT INTO impacts (subject, subject_kind, text, theme, revision, stated_at, event_id, retracted_at)
         VALUES ('session:3d4f5a96-77fa-478a-accc-d804f2fad104', 'session', 'Restored access', NULL, 1, '2026-09-01T00:00:00.000Z', 4, NULL)`,
      );
      const sessionRow = pre
        .query("SELECT subject_kind FROM impacts WHERE subject = ?")
        .get("session:3d4f5a96-77fa-478a-accc-d804f2fad104") as { subject_kind: string };
      expect(sessionRow.subject_kind).toBe("session");

      pre.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replays cleanly on the golden fixture DB, migrated end to end via openDatabase", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-migration-0016-empty-test-"));
    const dbPath = join(dir, "tempad.db");

    try {
      const database = openDatabase(dbPath);
      const version = (database.query("PRAGMA user_version;").get() as { user_version: number })
        .user_version;
      expect(version).toBe(21);
      const count = database.query("SELECT count(*) as n FROM impacts").get() as { n: number };
      expect(count.n).toBe(0);
      database.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
