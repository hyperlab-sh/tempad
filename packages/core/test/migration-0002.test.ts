import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

describe("migration 0002_org_project", () => {
  test("applies cleanly on an existing v1 database, new columns are nullable and blank", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-migration-test-"));
    const dbPath = join(dir, "tempad.db");

    try {
      const v1 = new Database(dbPath);
      v1.exec(readFileSync(join(MIGRATIONS_DIR, "0001_initial.sql"), "utf8"));
      v1.exec("PRAGMA user_version = 1;");

      v1.exec(
        `INSERT INTO gh_repos (full_name, org, is_personal, default_branch)
         VALUES ('acme/widgets', 'acme', 0, 'main')`,
      );
      v1.exec(
        `INSERT INTO monday_items (id, board_id, board_name, group_name, name, status, assignees, timeline_start, timeline_end, time_tracked_seconds, created_at, updated_at, raw)
         VALUES (1, 1, 'Board', NULL, 'item', NULL, '[]', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}')`,
      );
      v1.exec(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '~/.claude', 'dir', '/tmp/s1.jsonl', NULL, 'unassigned', 'unassigned', NULL, 'a title', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0, '[]', 'host', '2026-01-01T00:00:00.000Z')`,
      );
      v1.close();

      const database = openDatabase(dbPath);

      const version = (database.query("PRAGMA user_version;").get() as { user_version: number })
        .user_version;
      expect(version).toBe(25);

      const repo = database
        .query("SELECT project, meta FROM gh_repos WHERE full_name = ?")
        .get("acme/widgets") as { project: string | null; meta: string | null };
      expect(repo.project).toBeNull();
      expect(repo.meta).toBeNull();

      const item = database
        .query("SELECT org, project, meta FROM monday_items WHERE id = ?")
        .get(1) as { org: string | null; project: string | null; meta: string | null };
      expect(item.org).toBeNull();
      expect(item.project).toBeNull();
      expect(item.meta).toBeNull();

      const session = database
        .query("SELECT title_source, entrypoint, user_type FROM claude_sessions WHERE id = ?")
        .get("s1") as {
        title_source: string | null;
        entrypoint: string | null;
        user_type: string | null;
      };
      expect(session.title_source).toBeNull();
      expect(session.entrypoint).toBeNull();
      expect(session.user_type).toBeNull();

      database.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
