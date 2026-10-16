import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCollector, reresolveSessions } from "../src/collect/claude.ts";
import type { Config } from "../src/config/env.ts";
import { loadRules } from "../src/config/rules.ts";
import { openDatabase } from "../src/db/database.ts";
import { setSyncState } from "../src/db/sync-state.ts";

function makeConfig(home: string, claudeDirs: string[]): Config {
  return {
    mondayApiToken: "x",
    mondayUser: "x",
    ghUser: "x",
    ghOrgs: [],
    ghIncludePersonal: false,
    ghToken: undefined,
    gitAuthorEmails: [],
    claudeDirs,
    hostSlug: "test-host",
    tz: "UTC",
    since: "2020-01-01T00:00:00Z",
    syncToken: "unused",
    home,
  };
}

function writeJsonl(path: string, lines: unknown[]): void {
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("claude collector", () => {
  test("plain session with cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-claude-"));
    const home = join(root, "home");
    const claudeDir = join(root, "claude");
    const projectDir = join(root, "work", "acme", "widgets");
    mkdirSync(home, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(join(claudeDir, "projects", "plain-project"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(home, "tempad.toml"),
      `[[projects]]\npattern = "${root.replace(/\\/g, "\\\\")}/work/:org/:project/:rest*"\n`,
    );

    const sessionFile = join(claudeDir, "projects", "plain-project", "session-1.jsonl");
    writeJsonl(sessionFile, [
      {
        type: "user",
        uuid: "u1",
        sessionId: "sess-1",
        timestamp: "2026-01-01T10:00:00.000Z",
        cwd: projectDir,
        gitBranch: "main",
        origin: { kind: "human" },
        message: { role: "user", content: "hello there" },
      },
      {
        type: "assistant",
        uuid: "a1",
        sessionId: "sess-1",
        timestamp: "2026-01-01T10:00:05.000Z",
        cwd: projectDir,
        message: {
          role: "assistant",
          model: "claude-x",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "user",
        uuid: "u2",
        sessionId: "sess-1",
        timestamp: "2026-01-01T10:01:00.000Z",
        cwd: projectDir,
        origin: { kind: "human" },
        message: { role: "user", content: "do a thing" },
      },
      {
        type: "assistant",
        uuid: "a2",
        sessionId: "sess-1",
        timestamp: "2026-01-01T10:01:05.000Z",
        cwd: projectDir,
        message: {
          role: "assistant",
          model: "claude-x",
          content: [{ type: "tool_use", name: "Bash" }],
          usage: { input_tokens: 20, output_tokens: 8 },
        },
      },
      {
        type: "user",
        uuid: "u3",
        sessionId: "sess-1",
        timestamp: "2026-01-01T10:01:10.000Z",
        cwd: projectDir,
        origin: { kind: "tool" },
        message: { role: "user", content: "tool result" },
      },
      {
        type: "assistant",
        uuid: "a3",
        sessionId: "sess-1",
        timestamp: "2026-01-01T10:02:00.000Z",
        cwd: projectDir,
        message: {
          role: "assistant",
          model: "claude-x",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      },
    ]);

    try {
      const database = openDatabase(join(root, "tempad.db"));
      const config = makeConfig(home, [claudeDir]);

      const summary = await claudeCollector.sync(database, config, {});
      expect(summary.inserted).toBe(1);
      expect(summary.updated).toBe(0);
      expect(summary.warnings).toEqual([]);

      const session = database
        .query("SELECT * FROM claude_sessions WHERE id = 'sess-1'")
        .get() as Record<string, unknown>;
      expect(session.message_count).toBe(6);
      expect(session.tool_call_count).toBe(1);
      expect(session.org).toBe("acme");
      expect(session.project).toBe("widgets");
      expect(session.title).toBe("hello there");
      expect(session.title_source).toBe("first-message");
      expect(session.git_branch).toBe("main");

      const messageCount = (
        database
          .query("SELECT COUNT(*) as count FROM claude_messages WHERE session_id = 'sess-1'")
          .get() as {
          count: number;
        }
      ).count;
      expect(messageCount).toBe(6);

      // Idempotence: run again.
      const secondSummary = await claudeCollector.sync(database, config, {});
      expect(secondSummary.inserted).toBe(0);
      expect(secondSummary.updated).toBe(0);

      const messageCountAfter = (
        database
          .query("SELECT COUNT(*) as count FROM claude_messages WHERE session_id = 'sess-1'")
          .get() as {
          count: number;
        }
      ).count;
      expect(messageCountAfter).toBe(6);

      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("custom-title precedence, sidechain, tool_use, usage tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-claude-"));
    const home = join(root, "home");
    const claudeDir = join(root, "claude");
    const projectDir = join(root, "work", "acme", "widgets");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(claudeDir, "projects", "titled-project"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(home, "tempad.toml"),
      `[[projects]]\npattern = "${root.replace(/\\/g, "\\\\")}/work/:org/:project/:rest*"\n`,
    );

    const sessionFile = join(claudeDir, "projects", "titled-project", "session-2.jsonl");
    writeJsonl(sessionFile, [
      { type: "custom-title", customTitle: "My Custom Title", sessionId: "sess-2" },
      { type: "agent-name", agentName: "My Agent Name", sessionId: "sess-2" },
      {
        type: "user",
        uuid: "u1",
        sessionId: "sess-2",
        timestamp: "2026-01-02T10:00:00.000Z",
        cwd: projectDir,
        origin: { kind: "human" },
        message: { role: "user", content: "ignored because custom-title wins" },
      },
      {
        type: "user",
        uuid: "u2",
        sessionId: "sess-2",
        timestamp: "2026-01-02T10:00:01.000Z",
        cwd: projectDir,
        isSidechain: true,
        origin: { kind: "agent" },
        message: { role: "user", content: "sidechain message" },
      },
      {
        type: "assistant",
        uuid: "a1",
        sessionId: "sess-2",
        timestamp: "2026-01-02T10:00:05.000Z",
        cwd: projectDir,
        message: {
          role: "assistant",
          model: "claude-y",
          content: [{ type: "tool_use", name: "Read" }],
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 5,
            output_tokens: 40,
          },
        },
      },
    ]);

    try {
      const database = openDatabase(join(root, "tempad.db"));
      const config = makeConfig(home, [claudeDir]);

      const summary = await claudeCollector.sync(database, config, {});
      expect(summary.inserted).toBe(1);

      const session = database
        .query("SELECT * FROM claude_sessions WHERE id = 'sess-2'")
        .get() as Record<string, unknown>;
      expect(session.title).toBe("My Custom Title");
      expect(session.tool_call_count).toBe(1);

      const sidechainMessage = database
        .query("SELECT * FROM claude_messages WHERE uuid = 'u2'")
        .get() as Record<string, unknown>;
      expect(sidechainMessage.is_sidechain).toBe(1);
      expect(sidechainMessage.origin_kind).toBe("agent");

      const toolMessage = database
        .query("SELECT * FROM claude_messages WHERE uuid = 'a1'")
        .get() as Record<string, unknown>;
      expect(toolMessage.tool_name).toBe("Read");
      expect(toolMessage.tokens_in).toBe(125);
      expect(toolMessage.tokens_out).toBe(40);

      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed lines, no cwd, project_dir decodes to existing path", async () => {
    const root = mkdtempSync(join(tmpdir(), "tempadclaude"));
    const home = join(root, "home");
    const claudeDir = join(root, "claude");
    const decodedTarget = join(root, "work", "acme", "widgets");
    mkdirSync(home, { recursive: true });
    mkdirSync(decodedTarget, { recursive: true });

    const encodedFolderName = decodedTarget.replace(/\//g, "-");
    const sessionDir = join(claudeDir, "projects", encodedFolderName);
    mkdirSync(sessionDir, { recursive: true });

    writeFileSync(
      join(home, "tempad.toml"),
      `[[projects]]\npattern = "${root.replace(/\\/g, "\\\\")}/work/:org/:project/:rest*"\n`,
    );

    const sessionFile = join(sessionDir, "session-3.jsonl");
    const goodLines = [
      {
        type: "user",
        uuid: "u1",
        sessionId: "sess-3",
        timestamp: "2026-01-03T10:00:00.000Z",
        origin: { kind: "human" },
        message: { role: "user", content: "no cwd here" },
      },
      {
        type: "assistant",
        uuid: "a1",
        sessionId: "sess-3",
        timestamp: "2026-01-03T10:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
    ];
    const uuidLessLine = {
      type: "user",
      sessionId: "sess-3",
      timestamp: "2026-01-03T10:00:06.000Z",
      cwd: "/should/not/be/recorded",
      origin: { kind: "human" },
      message: { role: "user", content: "no uuid, should be skipped" },
    };
    const content = `${JSON.stringify(goodLines[0])}\nnot valid json\n${JSON.stringify(
      goodLines[1],
    )}\n{"broken":\n${JSON.stringify(uuidLessLine)}\n`;
    writeFileSync(sessionFile, content);

    try {
      const database = openDatabase(join(root, "tempad.db"));
      const config = makeConfig(home, [claudeDir]);

      const summary = await claudeCollector.sync(database, config, {});
      expect(summary.inserted).toBe(1);
      expect(summary.warnings.length).toBe(1);
      expect(summary.warnings[0]).toContain("3 malformed lines");

      const messageCount = (
        database
          .query("SELECT COUNT(*) as count FROM claude_messages WHERE session_id = 'sess-3'")
          .get() as {
          count: number;
        }
      ).count;
      expect(messageCount).toBe(2);

      const session = database
        .query("SELECT * FROM claude_sessions WHERE id = 'sess-3'")
        .get() as Record<string, unknown>;
      expect(session.org).toBe("acme");
      expect(session.project).toBe("widgets");
      expect(session.cwd).toBeNull();

      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mtime skip: future last_sync_at causes zero work", async () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-claude-"));
    const home = join(root, "home");
    const claudeDir = join(root, "claude");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(claudeDir, "projects", "skip-project"), { recursive: true });

    writeFileSync(
      join(home, "tempad.toml"),
      `[[projects]]\npattern = "~/work/:org/:project/:rest*"\n`,
    );

    const sessionFile = join(claudeDir, "projects", "skip-project", "session-4.jsonl");
    writeJsonl(sessionFile, [
      {
        type: "user",
        uuid: "u1",
        sessionId: "sess-4",
        timestamp: "2026-01-04T10:00:00.000Z",
        origin: { kind: "human" },
        message: { role: "user", content: "should be skipped" },
      },
    ]);

    try {
      const database = openDatabase(join(root, "tempad.db"));
      const config = makeConfig(home, [claudeDir]);

      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      setSyncState(database, "claude", future);

      const summary = await claudeCollector.sync(database, config, {});
      expect(summary.inserted).toBe(0);
      expect(summary.updated).toBe(0);

      const count = (
        database.query("SELECT COUNT(*) as count FROM claude_sessions").get() as { count: number }
      ).count;
      expect(count).toBe(0);

      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("multi-line first-message title collapses to one line, and re-sync updates a changed title", async () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-claude-"));
    const home = join(root, "home");
    const claudeDir = join(root, "claude");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(claudeDir, "projects", "hook-project"), { recursive: true });

    writeFileSync(
      join(home, "tempad.toml"),
      `[[projects]]\npattern = "~/work/:org/:project/:rest*"\n`,
    );

    const sessionFile = join(claudeDir, "projects", "hook-project", "session-5.jsonl");
    writeJsonl(sessionFile, [
      {
        type: "user",
        uuid: "u1",
        sessionId: "sess-5",
        timestamp: "2026-01-05T10:00:00.000Z",
        origin: { kind: "human" },
        message: {
          role: "user",
          content:
            "Review this change for security vulnerabilities.\n\nChanged files:\n- a.ts\n- b.ts",
        },
      },
    ]);

    try {
      const database = openDatabase(join(root, "tempad.db"));
      const config = makeConfig(home, [claudeDir]);

      await claudeCollector.sync(database, config, {});

      const session = database
        .query("SELECT title, title_source FROM claude_sessions WHERE id = 'sess-5'")
        .get() as { title: string; title_source: string };
      expect(session.title).toBe(
        "Review this change for security vulnerabilities. Changed files: - a.ts - b.ts",
      );
      expect(session.title).not.toContain("\n");
      expect(session.title_source).toBe("first-message");

      // Re-sync after the title source changes: the changed-row check must catch it.
      writeJsonl(sessionFile, [
        {
          type: "custom-title",
          sessionId: "sess-5",
          customTitle: "Security review",
        },
        {
          type: "user",
          uuid: "u1",
          sessionId: "sess-5",
          timestamp: "2026-01-05T10:00:00.000Z",
          origin: { kind: "human" },
          message: {
            role: "user",
            content:
              "Review this change for security vulnerabilities.\n\nChanged files:\n- a.ts\n- b.ts",
          },
        },
      ]);

      const secondSummary = await claudeCollector.sync(database, config, {});
      expect(secondSummary.updated).toBe(1);

      const updated = database
        .query("SELECT title, title_source FROM claude_sessions WHERE id = 'sess-5'")
        .get() as { title: string; title_source: string };
      expect(updated.title).toBe("Security review");
      expect(updated.title_source).toBe("custom-title");

      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fills project_name from a path rule and reresolveSessions updates it after a rule is added", async () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-claude-"));
    const home = join(root, "home");
    const claudeDir = join(root, "claude");
    const projectDir = join(root, "work", "mosaic", "coolify");
    mkdirSync(home, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(join(claudeDir, "projects", "coolify-project"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const tomlPath = join(home, "tempad.toml");
    writeFileSync(
      tomlPath,
      `[[projects]]\npattern = "${root.replace(/\\/g, "\\\\")}/work/:org/:project/:rest*"\n`,
    );

    const sessionFile = join(claudeDir, "projects", "coolify-project", "session-6.jsonl");
    writeJsonl(sessionFile, [
      {
        type: "user",
        uuid: "u1",
        sessionId: "sess-6",
        timestamp: "2026-01-01T10:00:00.000Z",
        cwd: projectDir,
        origin: { kind: "human" },
        message: { role: "user", content: "deploy the app" },
      },
    ]);

    try {
      const database = openDatabase(join(root, "tempad.db"));
      const config = makeConfig(home, [claudeDir]);

      await claudeCollector.sync(database, config, {});

      const beforeRow = database
        .query("SELECT project_name FROM claude_sessions WHERE id = 'sess-6'")
        .get() as { project_name: string | null };
      expect(beforeRow.project_name).toBeNull();

      writeFileSync(
        tomlPath,
        `[[projects]]\npath = "${projectDir.replace(/\\/g, "\\\\")}"\nname = "Dev Server"\norg = "mosaic"\nproject = "coolify"\n\n[[projects]]\npattern = "${root.replace(/\\/g, "\\\\")}/work/:org/:project/:rest*"\n`,
      );

      const rules = loadRules(tomlPath);
      const moved = reresolveSessions(database, rules, projectDir);
      expect(moved).toBe(1);

      const afterRow = database
        .query("SELECT org, project, project_name FROM claude_sessions WHERE id = 'sess-6'")
        .get() as { org: string; project: string; project_name: string | null };
      expect(afterRow).toEqual({ org: "mosaic", project: "coolify", project_name: "Dev Server" });

      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reresolveSessions prefilters in SQL and never realpath-resolves a session outside the path", async () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-claude-"));
    const home = join(root, "home");
    const targetDir = join(root, "work", "mosaic", "coolify");
    const otherDir = join(root, "work", "other", "thing");
    mkdirSync(home, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });

    const tomlPath = join(home, "tempad.toml");
    writeFileSync(
      tomlPath,
      `[[projects]]\npath = "${targetDir.replace(/\\/g, "\\\\")}"\nname = "Dev Server"\norg = "mosaic"\nproject = "coolify"\n`,
    );

    try {
      const database = openDatabase(join(root, "tempad.db"));
      database.exec(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('sess-target', '~/.claude', 'p', '/tmp/sess-target.jsonl', '${targetDir}', 'x', 'y', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0, '[]', 'test-host', '2026-01-01T00:00:00.000Z'),
                ('sess-other', '~/.claude', 'p', '/tmp/sess-other.jsonl', '${otherDir}', 'x', 'y', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0, '[]', 'test-host', '2026-01-01T00:00:00.000Z')`,
      );

      const rules = loadRules(tomlPath);

      const realpathSpy = spyOn(fs, "realpathSync");
      const moved = reresolveSessions(database, rules, targetDir);
      const resolvedPaths = realpathSpy.mock.calls.map((call) => call[0]);
      realpathSpy.mockRestore();

      expect(moved).toBe(1);
      expect(resolvedPaths).not.toContain(otherDir);

      const row = database
        .query("SELECT project_name FROM claude_sessions WHERE id = 'sess-target'")
        .get() as { project_name: string | null };
      expect(row.project_name).toBe("Dev Server");

      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
