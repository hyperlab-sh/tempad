import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { defaultIntentConfig } from "../../src/intent/config";
import { declareQuest } from "../../src/intent/declarations";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import type { SpawnFn } from "../../src/w5/cli";
import {
  planW5Command,
  runReviewCommand,
  runW5Command,
  runW5HookCommand,
  settingsPathFor,
} from "../../src/w5/cli";
import {
  hasUnstableInstall,
  isUnstableInstallPath,
  PLUGIN_RECOMMENDATION_MESSAGE,
  promptHookScriptPath,
  stopHookScriptPath,
  UNSTABLE_INSTALL_MESSAGE,
} from "../../src/w5/hooks";
import { withEnvironment } from "../isolation";

registerAllProjections();

function makeConfig(home: string): Config {
  return {
    mondayApiToken: "t",
    mondayUser: "u",
    ghUser: "u",
    ghOrgs: [],
    ghIncludePersonal: false,
    ghToken: undefined,
    gitAuthorEmails: [],
    claudeDirs: [],
    hostSlug: "host",
    tz: "UTC",
    since: "2020-01-01",
    syncToken: "unused",
    home,
  };
}

describe("w5 enqueue", () => {
  test("spawns the runner detached when the lock is free", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      const database = openDatabase(":memory:");
      const spawnCalls: Parameters<SpawnFn>[0][] = [];
      const spawn: SpawnFn = (options) => {
        spawnCalls.push(options);
      };

      process.env.TEMPAD_SYNC_TOKEN = "sync-secret-jwt";
      process.env.MONDAY_API_TOKEN = "monday-secret";
      process.env.GH_TOKEN = "github-secret";
      process.env.ANTHROPIC_API_KEY = "sk-ant-passes-through";
      let code: number;
      try {
        code = await runW5Command(["enqueue", "--session", "s1"], {
          database,
          config: makeConfig(dir),
          intentConfig: defaultIntentConfig(),
          stdout: () => {},
          spawn,
        });
      } finally {
        for (const name of [
          "TEMPAD_SYNC_TOKEN",
          "MONDAY_API_TOKEN",
          "GH_TOKEN",
          "ANTHROPIC_API_KEY",
        ]) {
          delete process.env[name];
        }
      }

      expect(code).toBe(0);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.detached).toBe(true);
      expect(spawnCalls[0]?.cmd).toContain("w5");
      expect(spawnCalls[0]?.cmd).toContain("run");
      // The detached run inherits the hook's cwd (a user's project); its .env must not load.
      expect(spawnCalls[0]?.cmd).toContain("--no-env-file");
      expect(spawnCalls[0]?.env?.TEMPAD_SYNC_TOKEN).toBeUndefined();
      expect(spawnCalls[0]?.env?.MONDAY_API_TOKEN).toBeUndefined();
      expect(spawnCalls[0]?.env?.GH_TOKEN).toBeUndefined();
      expect(spawnCalls[0]?.env?.ANTHROPIC_API_KEY).toBe("sk-ant-passes-through");
      expect(spawnCalls[0]?.env?.TEMPAD_HOME).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not spawn the runner when the lock file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      writeFileSync(join(dir, "w5.lock"), "12345");
      const database = openDatabase(":memory:");
      const spawnCalls: unknown[] = [];
      const spawn: SpawnFn = (options) => {
        spawnCalls.push(options);
      };

      await runW5Command(["enqueue", "--session", "s1"], {
        database,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn,
      });

      expect(spawnCalls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale lock does not wedge the queue: enqueue --forced clears it and spawns the runner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      const lockPath = join(dir, "w5.lock");
      writeFileSync(lockPath, String(Bun.spawnSync(["true"]).pid));
      const staleTime = new Date(Date.now() - 31 * 60_000);
      utimesSync(lockPath, staleTime, staleTime);

      const database = openDatabase(":memory:");
      const spawnCalls: Parameters<SpawnFn>[0][] = [];
      const spawn: SpawnFn = (options) => {
        spawnCalls.push(options);
      };

      const code = await runW5Command(["enqueue", "--session", "s1", "--forced"], {
        database,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn,
      });

      expect(code).toBe(0);
      expect(existsSync(lockPath)).toBe(false);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.detached).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w5 run lock ownership", () => {
  function inHome(run: (dir: string, lockPath: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    return run(dir, join(dir, "w5.lock")).finally(() =>
      rmSync(dir, { recursive: true, force: true }),
    );
  }

  const runInline = (dir: string, database = openDatabase(":memory:")) =>
    runW5Command(["run"], {
      database,
      config: makeConfig(dir),
      intentConfig: defaultIntentConfig(),
      stdout: () => {},
      spawn: () => {},
    });

  test("takes the lock while it drains and removes its own when done", async () => {
    await inHome(async (dir, lockPath) => {
      const database = openDatabase(":memory:");
      const held: string[] = [];
      const watched = new Proxy(database, {
        get(target, property) {
          if (property === "query") {
            return (sql: string) => {
              if (held.length === 0 && existsSync(lockPath)) {
                held.push(readFileSync(lockPath, "utf8"));
              }
              return target.query(sql);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      expect(await runInline(dir, watched)).toBe(0);
      expect(held).toEqual([String(process.pid)]);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test("does not run, or touch the lock, while another live runner holds it", async () => {
    await inHome(async (dir, lockPath) => {
      writeFileSync(lockPath, String(process.pid));
      const lines: string[] = [];
      const database = openDatabase(":memory:");
      const queried: string[] = [];
      const watched = new Proxy(database, {
        get(target, property) {
          if (property === "query") {
            return (sql: string) => {
              queried.push(sql);
              return target.query(sql);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const code = await runW5Command(["run"], {
        database: watched,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: (line) => lines.push(line),
        spawn: () => {},
      });

      expect(code).toBe(0);
      expect(lines).toEqual([]);
      expect(queried.some((sql) => sql.includes("w5_jobs"))).toBe(false);
      expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    });
  });

  test("a runner that finishes after its lock was replaced leaves the new one alone", async () => {
    await inHome(async (dir, lockPath) => {
      const database = openDatabase(":memory:");
      const otherRunner = String(Bun.spawnSync(["true"]).pid);
      let swapped = false;
      const watched = new Proxy(database, {
        get(target, property) {
          if (property === "query") {
            return (sql: string) => {
              if (!swapped && sql.includes("w5_jobs")) {
                swapped = true;
                // Cleared as stale by another runner, which took its own.
                rmSync(lockPath);
                writeFileSync(lockPath, otherRunner);
              }
              return target.query(sql);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      expect(await runInline(dir, watched)).toBe(0);
      expect(swapped).toBe(true);
      expect(readFileSync(lockPath, "utf8")).toBe(otherRunner);
    });
  });

  test("the lock is released when the drain throws", async () => {
    await inHome(async (dir, lockPath) => {
      const database = openDatabase(":memory:");
      const exploding = new Proxy(database, {
        get(target, property) {
          if (property === "query") {
            return (sql: string) => {
              if (sql.includes("w5_jobs")) throw new Error("database is gone");
              return target.query(sql);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await expect(runInline(dir, exploding)).rejects.toThrow("database is gone");
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});

describe("w5 run stale lock", () => {
  test("removes a lock older than 30 minutes and continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      const lockPath = join(dir, "w5.lock");
      writeFileSync(lockPath, String(Bun.spawnSync(["true"]).pid));
      const staleTime = new Date(Date.now() - 31 * 60_000);
      utimesSync(lockPath, staleTime, staleTime);

      const database = openDatabase(":memory:");
      const spawn: SpawnFn = () => {};

      const code = await runW5Command(["run", "--detached"], {
        database,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn,
      });

      expect(code).toBe(0);

      const logContent = await Bun.file(join(dir, "logs", "w5.log")).text();
      expect(logContent).toContain("stale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lock older than 30 minutes whose runner is still alive blocks the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      const lockPath = join(dir, "w5.lock");
      writeFileSync(lockPath, String(process.pid));
      const oldTime = new Date(Date.now() - 3 * 60 * 60_000);
      utimesSync(lockPath, oldTime, oldTime);

      const spawnCalls: unknown[] = [];
      await runW5Command(["run", "--detached"], {
        database: openDatabase(":memory:"),
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn: (options) => {
          spawnCalls.push(options);
        },
      });

      expect(spawnCalls).toHaveLength(0);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh lock blocks the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      const lockPath = join(dir, "w5.lock");
      writeFileSync(lockPath, "12345");

      const database = openDatabase(":memory:");
      const spawnCalls: unknown[] = [];
      const spawn: SpawnFn = (options) => {
        spawnCalls.push(options);
      };

      await runW5Command(["run", "--detached"], {
        database,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn,
      });

      expect(spawnCalls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w5 backend selection", () => {
  test("claude-cli backend never requires ANTHROPIC_API_KEY and spawns the claude command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    const previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const database = openDatabase(":memory:");
      ensureTables(database);
      const sessionFilePath = join(dir, "s1.jsonl");
      writeFileSync(
        sessionFilePath,
        `${JSON.stringify({
          type: "user",
          uuid: "m1",
          sessionId: "s1",
          timestamp: "2026-09-05T10:00:00.000Z",
          message: { role: "user", content: "work" },
        })}\n`,
      );
      database
        .query(
          `INSERT INTO claude_sessions
            (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
             started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
           VALUES ('s1', ?, 'p', ?, '/w/p', 'personal', 'p', 't', 'main',
                   '2026-09-05T10:00:00.000Z', '2026-09-05T10:00:00.000Z', 1, 0, '[]', 'host', '2026-09-05T10:00:00.000Z')`,
        )
        .run(dir, sessionFilePath);
      database
        .query(
          "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES ('m1', 's1', '2026-09-05T10:00:00.000Z', 'user', 0, 'work')",
        )
        .run();
      database
        .query(
          "INSERT INTO w5_jobs (session_id, kind, forced, requested_at, state) VALUES ('s1', 'classify', 1, '2026-09-05T10:00:00.000Z', 'queued')",
        )
        .run();

      const spawn: SpawnFn = () => {};
      const intentConfig = defaultIntentConfig();
      intentConfig.w5.backend = "claude-cli";
      intentConfig.w5.claudeCommand = "definitely-not-a-real-binary-xyz";
      const code = await runW5Command(["run"], {
        database,
        config: makeConfig(dir),
        intentConfig,
        stdout: () => {},
        spawn,
      });

      expect(code).toBe(0);
      const job = database.query("SELECT state, error FROM w5_jobs").get() as {
        state: string;
        error: string;
      };
      expect(job.state).toBe("failed");
      expect(job.error).not.toContain("ANTHROPIC_API_KEY not set");
    } finally {
      if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w5 run without ANTHROPIC_API_KEY", () => {
  test("marks the job failed and exits 0 without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    const previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const database = openDatabase(":memory:");
      ensureTables(database);
      const sessionFilePath = join(dir, "s1.jsonl");
      writeFileSync(
        sessionFilePath,
        `${JSON.stringify({
          type: "user",
          uuid: "m1",
          sessionId: "s1",
          timestamp: "2026-09-05T10:00:00.000Z",
          message: { role: "user", content: "work" },
        })}\n`,
      );
      database
        .query(
          `INSERT INTO claude_sessions
            (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
             started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
           VALUES ('s1', ?, 'p', ?, '/w/p', 'personal', 'p', 't', 'main',
                   '2026-09-05T10:00:00.000Z', '2026-09-05T10:00:00.000Z', 1, 0, '[]', 'host', '2026-09-05T10:00:00.000Z')`,
        )
        .run(dir, sessionFilePath);
      database
        .query(
          "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES ('m1', 's1', '2026-09-05T10:00:00.000Z', 'user', 0, 'work')",
        )
        .run();
      database
        .query(
          "INSERT INTO w5_jobs (session_id, kind, forced, requested_at, state) VALUES ('s1', 'classify', 1, '2026-09-05T10:00:00.000Z', 'queued')",
        )
        .run();

      const spawn: SpawnFn = () => {};
      const intentConfig = defaultIntentConfig();
      intentConfig.w5.backend = "api";
      const code = await runW5Command(["run"], {
        database,
        config: makeConfig(dir),
        intentConfig,
        stdout: () => {},
        spawn,
      });

      expect(code).toBe(0);
      const job = database.query("SELECT state, error FROM w5_jobs").get() as {
        state: string;
        error: string;
      };
      expect(job.state).toBe("failed");
      expect(job.error).toContain("ANTHROPIC_API_KEY not set");
      expect(job.error).not.toContain("at ");

      const logContent = readFileSync(join(dir, "logs", "w5.log"), "utf8");
      expect(logContent).toContain("ANTHROPIC_API_KEY not set");
      expect(logContent).not.toMatch(/\bat .*:\d+:\d+/);
      expect(logContent).not.toContain("    at ");
    } finally {
      if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w5 context", () => {
  test("prints the declaration line before any question lines", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: heroId,
        payload: { name: "S" },
      }),
    );
    declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: "Ship X", outcome: "ship it", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    const lines: string[] = [];
    const code = await runW5Command(["context", "--session", "s1"], {
      database,
      config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n").split("\n");
    expect(output[0]).toBe(
      "tempad: session s1, active quests: Ship X [Q1]. Declare with the tempad-quest skill if this prompt starts a different outcome.",
    );
  });

  describe("a declare question and the session's declarations", () => {
    function seedAsked() {
      const database = openDatabase(":memory:");
      ensureTables(database);
      const store = new EventStore(database);
      const heroId = newUlid();
      applyIncremental(
        database,
        store.append({
          actor: "hero",
          kind: "hero.created",
          subject: heroId,
          payload: { name: "S" },
        }),
      );
      database
        .query(
          "INSERT INTO stints (id, outcome, opened_at, revision) VALUES ('A1', 'o', '2026-09-07T08:00:00.000Z', 1)",
        )
        .run();
      database
        .query(
          `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
           VALUES ('T1', 'A1', 'claude-code', 'p', 'session', '2026-09-07T08:00:00.000Z', '2026-09-07T08:20:00.000Z', 'hero', 'w', 'y', 'p', 'claude-code', 0.6, 'assistant', 's1', '2026-09-07T08:20:00.000Z')`,
        )
        .run();
      applyIncremental(
        database,
        store.append({
          actor: "hook",
          kind: "question.asked",
          subject: "Q-declare",
          sessionId: "s1",
          payload: { trace: "T1", kind: "declare", text: "declare" },
        }),
      );
      applyIncremental(
        database,
        store.append({
          actor: "system",
          kind: "question.promoted",
          subject: "Q-declare",
          at: "2026-09-07T09:05:00.000Z",
          payload: { turnsAtAsk: 3 },
        }),
      );
      const declareInSession = (done = false, questId?: string) =>
        declareQuest(store, database, {
          sessionId: "s1",
          ...(questId
            ? { questId }
            : { newQuest: { title: "Ship X", outcome: "ship it", commitment: "personal" } }),
          plan: [],
          scope: "session",
          declaredBy: "agent",
          at: "2026-09-07T09:00:00.000Z",
          heroId,
          done,
        });
      return { database, store, declareInSession };
    }

    async function contextOutput(database: ReturnType<typeof openDatabase>): Promise<string> {
      const lines: string[] = [];
      await runW5Command(["context", "--session", "s1"], {
        database,
        config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
        intentConfig: defaultIntentConfig(),
        stdout: (line) => lines.push(line),
      });
      return lines.join("\n");
    }

    test("an asked declare question is not rendered once the session has an active quest", async () => {
      const { database, declareInSession } = seedAsked();
      declareInSession();

      const output = await contextOutput(database);

      expect(output).toContain("active quests: Ship X [Q1]");
      expect(output).not.toContain("no declared quest");
    });

    test("an asked declare question is not rendered once the session declared as a subagent", async () => {
      const { database, store } = seedAsked();
      const heroId = (database.query("SELECT id FROM heroes").get() as { id: string }).id;
      declareQuest(store, database, {
        sessionId: "s1",
        parentSessionId: "parent",
        newQuest: { title: "Sub errand", outcome: "o", commitment: "personal" },
        plan: [],
        scope: "subagent",
        declaredBy: "agent",
        at: "2026-09-07T09:00:00.000Z",
        heroId,
      });

      const output = await contextOutput(database);

      expect(output).not.toContain("no declared quest");
    });

    test("it is still rendered with no declaration", async () => {
      const { database } = seedAsked();
      const output = await contextOutput(database);
      expect(output).toContain("active quests: none");
      expect(output).toContain("w5 has no declared quest for this session");
    });

    test("it is still rendered when the only declared quest was ended", async () => {
      const { database, declareInSession } = seedAsked();
      const { questId } = declareInSession();
      declareInSession(true, questId);

      const output = await contextOutput(database);

      expect(output).toContain("active quests: none");
      expect(output).toContain("w5 has no declared quest for this session");
    });
  });

  test("prints 'active quests: none' with no declaration", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);

    const lines: string[] = [];
    const code = await runW5Command(["context", "--session", "s1"], {
      database,
      config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("tempad: session s1, active quests: none.");
  });

  test("a subagent declared via --parent shows its quest in the context line", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: heroId,
        payload: { name: "S" },
      }),
    );
    declareQuest(store, database, {
      sessionId: "kid1",
      parentSessionId: "lead1",
      newQuest: { title: "Ship l1a", outcome: "ship it", commitment: "personal" },
      plan: ["agent spawned event"],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    const lines: string[] = [];
    const code = await runW5Command(["context", "--session", "kid1"], {
      database,
      config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("tempad: session kid1, active quests: Ship l1a [Q1]");
  });

  test("a subagent whose own quest is retracted falls back to the parent's", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: heroId,
        payload: { name: "S" },
      }),
    );
    const { questId } = declareQuest(store, database, {
      sessionId: "kid1",
      parentSessionId: "lead1",
      newQuest: { title: "Gone", outcome: "o", commitment: "personal" },
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    }) as { questId: string };
    // The subagent's own quest no longer resolves (retracted), so the line
    // falls back to the lead session's active quests, like `buildWindow` does.
    database
      .query("UPDATE quests SET retracted_at = ? WHERE id = ?")
      .run("2026-09-07T09:05:00.000Z", questId);
    declareQuest(store, database, {
      sessionId: "lead1",
      newQuest: { title: "Parent quest", outcome: "o", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T08:00:00.000Z",
      heroId,
    });

    const lines: string[] = [];
    await runW5Command(["context", "--session", "kid1"], {
      database,
      config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => lines.push(line),
    });
    expect(lines.join("\n")).toContain("active quests: Parent quest [Q1]");
  });
});

function insertStint(
  database: ReturnType<typeof openDatabase>,
  options: { id: string; outcome?: string; dismissed?: boolean },
): void {
  database
    .query(
      "INSERT INTO stints (id, outcome, opened_at, revision, dismissed_at) VALUES (?, ?, '2026-09-01T00:00:00.000Z', 1, ?)",
    )
    .run(
      options.id,
      options.outcome ?? "work",
      options.dismissed ? "2026-09-01T01:00:00.000Z" : null,
    );
}

describe("tempad review", () => {
  test("lists a trace with a recorded doubt even though no question was ever asked", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    insertStint(database, { id: "A1" });
    database
      .query(
        `INSERT INTO traces
          (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at, doubt)
          VALUES ('T1', 'A1', 'claude-code', 'p', 'session', ?, ?, 'hero', 'a side errand', 'y', 'p', 'claude-code', 0.9, 'assistant', 's1', ?, 'unrecognized quest alias')`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    const lines: string[] = [];
    const code = runReviewCommand([], {
      database,
      config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(
      lines.some((line) => line.includes("T1") && line.includes("unrecognized quest alias")),
    ).toBe(true);
  });

  test("excludes a doubt whose stint has been dismissed", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    insertStint(database, { id: "A1", dismissed: true });
    database
      .query(
        `INSERT INTO traces
          (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at, doubt)
          VALUES ('T3', 'A1', 'claude-code', 'p', 'session', ?, ?, 'hero', 'a side errand', 'y', 'p', 'claude-code', 0.9, 'assistant', 's1', ?, 'unrecognized quest alias')`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    const lines: string[] = [];
    const code = runReviewCommand([], {
      database,
      config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(lines.some((line) => line.includes("T3"))).toBe(false);
  });

  test("an expired classifier question offers only the --quest answer, never --belongs", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "question.asked",
        subject: "Q-shift",
        sessionId: "s1",
        payload: { trace: "T", kind: "which_quest", text: "which quest is this?" },
      }),
    );
    applyIncremental(
      database,
      store.append({ actor: "system", kind: "question.expired", subject: "Q-shift", payload: {} }),
    );

    const lines: string[] = [];
    runReviewCommand([], {
      database,
      config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => lines.push(line),
    });

    const line = lines.find((candidate) => candidate.includes("Q-shift expired"));
    expect(line).toContain('  tempad answer Q-shift --quest <quest-id> --why "<reason>"\n');
    expect(line).toContain(
      '  tempad answer Q-shift --quest new:"<title>" --why "<reason>" [--origin',
    );
    expect(line).not.toContain("--belongs");
  });

  test("lists an expired declare question only while the session has no active quest", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: heroId,
        payload: { name: "S" },
      }),
    );
    for (const sessionId of ["s1", "s2"]) {
      applyIncremental(
        database,
        store.append({
          actor: "hook",
          kind: "question.asked",
          subject: `Q-${sessionId}`,
          sessionId,
          payload: { trace: "T", kind: "declare", text: "declare" },
        }),
      );
      applyIncremental(
        database,
        store.append({
          actor: "system",
          kind: "question.expired",
          subject: `Q-${sessionId}`,
          payload: {},
        }),
      );
    }
    declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: "Ship X", outcome: "ship it", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    const lines: string[] = [];
    runReviewCommand([], {
      database,
      config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => lines.push(line),
    });

    const output = lines.join("\n");
    expect(output).not.toContain("Q-s1");
    expect(output).toContain("Q-s2 expired");
    expect(output).toContain("--session s2");
  });

  describe("an expired declare question", () => {
    function seedExpired() {
      const database = openDatabase(":memory:");
      ensureTables(database);
      const store = new EventStore(database);
      const heroId = newUlid();
      applyIncremental(
        database,
        store.append({
          actor: "hero",
          kind: "hero.created",
          subject: heroId,
          payload: { name: "S" },
        }),
      );
      applyIncremental(
        database,
        store.append({
          actor: "hook",
          kind: "question.asked",
          subject: "Q-s1",
          sessionId: "s1",
          payload: { trace: "T", kind: "declare", text: "declare" },
        }),
      );
      applyIncremental(
        database,
        store.append({ actor: "system", kind: "question.expired", subject: "Q-s1", payload: {} }),
      );
      const declareInSession = (extra: Partial<Parameters<typeof declareQuest>[2]> = {}) =>
        declareQuest(store, database, {
          sessionId: "s1",
          newQuest: { title: "Ship X", outcome: "ship it", commitment: "personal" },
          plan: [],
          scope: "session",
          declaredBy: "agent",
          at: "2026-09-07T09:00:00.000Z",
          heroId,
          ...extra,
        });
      const review = () => {
        const lines: string[] = [];
        runReviewCommand([], {
          database,
          config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
          intentConfig: defaultIntentConfig(),
          stdout: (line) => lines.push(line),
        });
        return lines.join("\n");
      };
      return { database, store, heroId, declareInSession, review };
    }

    test("is hidden for a session that declared a quest and later ended it", () => {
      const { declareInSession, review } = seedExpired();
      const { questId } = declareInSession();
      declareInSession({
        newQuest: undefined,
        questId,
        done: true,
        at: "2026-09-07T10:00:00.000Z",
      });

      expect(review()).not.toContain("Q-s1");
    });

    test("is hidden for a session whose parent declared (subagent declaration)", () => {
      const { declareInSession, review } = seedExpired();
      declareInSession({ scope: "subagent", parentSessionId: "parent" });

      expect(review()).not.toContain("Q-s1");
    });

    test("is hidden for a subagent whose own declaration was retracted while its parent declared", () => {
      const { database, store, heroId, declareInSession, review } = seedExpired();
      declareQuest(store, database, {
        sessionId: "parent",
        newQuest: { title: "Parent quest", outcome: "o", commitment: "personal" },
        plan: [],
        scope: "session",
        declaredBy: "hero",
        at: "2026-09-07T08:00:00.000Z",
        heroId,
      });
      const { questId } = declareInSession({ scope: "subagent", parentSessionId: "parent" });
      applyIncremental(
        database,
        store.append({
          actor: "hero",
          kind: "retracted",
          subject: questId,
          payload: { retracts: "x", reason: "mistake" },
        }),
      );

      expect(review()).not.toContain("Q-s1");
    });

    test("is still listed when the only declaration was for a retracted quest", () => {
      const { database, store, declareInSession, review } = seedExpired();
      const { questId } = declareInSession();
      applyIncremental(
        database,
        store.append({
          actor: "hero",
          kind: "retracted",
          subject: questId,
          payload: { retracts: "x", reason: "mistake" },
        }),
      );

      const output = review();

      expect(output).toContain("Q-s1 expired");
      expect(output).toContain("--session s1");
    });

    test("is listed for a session that never declared", () => {
      expect(seedExpired().review()).toContain("Q-s1 expired");
    });
  });

  test("omits a doubt older than the review window", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    insertStint(database, { id: "A1" });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    database
      .query(
        `INSERT INTO traces
          (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at, doubt)
          VALUES ('T2', 'A1', 'claude-code', 'p', 'session', ?, ?, 'hero', 'old errand', 'y', 'p', 'claude-code', 0.9, 'assistant', 's1', ?, 'old doubt')`,
      )
      .run(old, old, old);

    const lines: string[] = [];
    const code = runReviewCommand([], {
      database,
      config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(lines.some((line) => line.includes("T2"))).toBe(false);
  });

  test("a custom --days widens or narrows the review window", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    insertStint(database, { id: "A1" });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    database
      .query(
        `INSERT INTO traces
          (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at, doubt)
          VALUES ('T4', 'A1', 'claude-code', 'p', 'session', ?, ?, 'hero', 'ten days ago', 'y', 'p', 'claude-code', 0.9, 'assistant', 's1', ?, 'a doubt')`,
      )
      .run(tenDaysAgo, tenDaysAgo, tenDaysAgo);

    const defaultLines: string[] = [];
    runReviewCommand([], {
      database,
      config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => defaultLines.push(line),
    });
    expect(defaultLines.some((line) => line.includes("T4"))).toBe(false);

    const widerLines: string[] = [];
    const code = runReviewCommand(["--days", "14"], {
      database,
      config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => widerLines.push(line),
    });
    expect(code).toBe(0);
    expect(widerLines.some((line) => line.includes("T4"))).toBe(true);
  });

  test("rejects a non-positive-integer --days with a usage message and exit 2", () => {
    for (const args of [["--days", "abc"], ["--days=-5"], ["--days", "0"], ["--days", "3.5"]]) {
      const database = openDatabase(":memory:");
      ensureTables(database);
      const lines: string[] = [];
      const code = runReviewCommand(args, {
        database,
        config: makeConfig(mkdtempSync(join(tmpdir(), "tempad-cli-test-"))),
        intentConfig: defaultIntentConfig(),
        stdout: (line) => lines.push(line),
      });

      expect(code).toBe(2);
      expect(lines.some((line) => line.includes("usage"))).toBe(true);
    }
  });
});

describe("planW5Command", () => {
  test("w5 run needs CLAUDE_DIRS and HOST_SLUG fields, w5 eval needs tz, the rest nothing", () => {
    expect(planW5Command("w5", ["run"])?.needs).toEqual(["claudeDirs", "hostSlug"]);
    expect(planW5Command("w5", ["run", "--detached"])?.needs).toEqual(["claudeDirs", "hostSlug"]);
    expect(planW5Command("w5", ["eval", "--from", "a"])?.needs).toEqual(["tz"]);
    for (const subcommand of ["enqueue", "context", "backfill", "dedupe", "hook"]) {
      expect(planW5Command("w5", [subcommand])?.needs).toEqual([]);
    }
    expect(planW5Command("quiet", ["2h"])?.needs).toEqual([]);
    expect(planW5Command("review", [])?.needs).toEqual([]);
  });

  test("only enqueue and context are silent on an unconfigured home", () => {
    const silent = ["enqueue", "context", "run", "backfill", "dedupe", "eval", "hook"].filter(
      (subcommand) => planW5Command("w5", [subcommand])?.silentWhenUnconfigured,
    );
    expect(silent).toEqual(["enqueue", "context"]);
    expect(planW5Command("quiet", ["2h"])?.silentWhenUnconfigured).toBe(false);
    expect(planW5Command("review", [])?.silentWhenUnconfigured).toBe(false);
  });

  test("hook is the only w5 subcommand that opens no database", () => {
    expect(planW5Command("w5", ["hook", "uninstall"])?.opensDatabase).toBe(false);
    for (const subcommand of ["enqueue", "context", "run", "backfill", "dedupe", "eval"]) {
      expect(planW5Command("w5", [subcommand])?.opensDatabase).toBe(true);
    }
    expect(planW5Command("quiet", ["2h"])?.opensDatabase).toBe(true);
    expect(planW5Command("review", [])?.opensDatabase).toBe(true);
  });

  test("labels name the command as the user typed it", () => {
    expect(planW5Command("w5", ["run"])?.label).toBe("tempad w5 run");
    expect(planW5Command("quiet", ["30m"])?.label).toBe("tempad quiet");
  });

  test("an unknown or missing subcommand has no plan", () => {
    expect(planW5Command("w5", ["frobnicate"])).toBeNull();
    expect(planW5Command("w5", [])).toBeNull();
  });
});

describe("w5 run / eval without the fields they need", () => {
  test("w5 run throws a clear error when the dispatcher did not load CLAUDE_DIRS and HOST_SLUG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      await expect(
        runW5Command(["run"], {
          database: openDatabase(":memory:"),
          config: { home: dir },
          intentConfig: defaultIntentConfig(),
          stdout: () => {},
        }),
      ).rejects.toThrow(/claudeDirs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("w5 eval throws a clear error when the dispatcher did not load TZ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      await expect(
        runW5Command(["eval", "--from", "2026-01-01", "--to", "2026-01-02"], {
          database: openDatabase(":memory:"),
          config: { home: dir },
          intentConfig: defaultIntentConfig(),
          stdout: () => {},
        }),
      ).rejects.toThrow(/tz/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Runs `tempad w5 hook ...` with HOME pointing at a fresh directory (and CLAUDE_CONFIG_DIR
 * unset, or set to `configDir`); captures console output.
 */
function runHookCommand(
  args: string[],
  options: { configDir?: string; home?: string; realGuard?: boolean } = {},
): {
  code: number;
  out: string[];
  err: string[];
  home: string;
  settingsPath: string;
} {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "tempad-hook-cli-"));
  const settingsPath = join(home, ".claude", "settings.json");
  const savedLog = console.log;
  const savedError = console.error;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    const code = withEnvironment(
      { HOME: home, CLAUDE_CONFIG_DIR: options.configDir ?? null },
      // Judge only the `--bin` path: the real guard also looks at where the hook scripts live,
      // which is wherever this checkout is, and a checkout under /tmp (a CI or review clone)
      // would refuse every install these tests expect to succeed.
      () =>
        runW5HookCommand(
          args,
          options.realGuard
            ? undefined
            : {
                hasUnstableInstall: (binary) =>
                  binary !== undefined && isUnstableInstallPath(binary),
              },
        ),
    );
    return { code, out, err, home, settingsPath };
  } finally {
    console.log = savedLog;
    console.error = savedError;
  }
}

describe("w5 hook install", () => {
  test("prints the plugin recommendation after installing the hooks", () => {
    const { code, out, settingsPath } = runHookCommand([
      "install",
      "--bin",
      "/opt/tempad/src/cli.ts",
    ]);
    try {
      expect(code).toBe(0);
      expect(existsSync(settingsPath)).toBe(true);
      expect(out).toContain(PLUGIN_RECOMMENDATION_MESSAGE);
    } finally {
      rmSync(join(settingsPath, "..", ".."), { recursive: true, force: true });
    }
  });

  test("the production guard refuses a bunx binary with no seam given, wherever this checkout lives", () => {
    // `realGuard` passes no options at all, so `runW5HookCommand` uses `hasUnstableInstall`.
    // A bunx path is unstable on any machine, so this holds for a checkout under /tmp too.
    const { code, out, err, settingsPath } = runHookCommand(
      [
        "install",
        "--bin",
        "/home/me/cache/bunx-501-@hyperlab.sh/tempad@0.1.0/node_modules/@hyperlab.sh/tempad/src/cli.ts",
      ],
      { realGuard: true },
    );
    try {
      expect(code).toBe(1);
      expect(err).toContain(UNSTABLE_INSTALL_MESSAGE);
      expect(out).not.toContain(PLUGIN_RECOMMENDATION_MESSAGE);
      expect(existsSync(settingsPath)).toBe(false);
    } finally {
      rmSync(join(settingsPath, "..", ".."), { recursive: true, force: true });
    }
  });

  test("refuses to write hooks that point into the scoped bunx directory", () => {
    const { code, err, settingsPath } = runHookCommand([
      "install",
      "--bin",
      "/home/me/cache/bunx-501-@hyperlab.sh/tempad@0.1.0/node_modules/@hyperlab.sh/tempad/src/cli.ts",
    ]);
    try {
      expect(code).toBe(1);
      expect(err).toContain(UNSTABLE_INSTALL_MESSAGE);
      expect(existsSync(settingsPath)).toBe(false);
    } finally {
      rmSync(join(settingsPath, "..", ".."), { recursive: true, force: true });
    }
  });

  test("refuses to write hooks that point into bunx's temporary directory", () => {
    const { code, out, err, settingsPath } = runHookCommand([
      "install",
      "--bin",
      "/var/folders/ab/xyz/T/bunx-501-tempad@0.1.0/node_modules/tempad/src/cli.ts",
    ]);
    try {
      expect(code).toBe(1);
      expect(err).toContain(UNSTABLE_INSTALL_MESSAGE);
      expect(UNSTABLE_INSTALL_MESSAGE).toContain("claude plugin install tempad@hyperlab");
      expect(UNSTABLE_INSTALL_MESSAGE).toContain("bun add -g @hyperlab.sh/tempad");
      expect(out).not.toContain(PLUGIN_RECOMMENDATION_MESSAGE);
      expect(existsSync(settingsPath)).toBe(false);
    } finally {
      rmSync(join(settingsPath, "..", ".."), { recursive: true, force: true });
    }
  });

  test("uninstall is not affected by where the CLI lives", () => {
    const { code, err, settingsPath } = runHookCommand(["uninstall"]);
    try {
      expect(code).toBe(0);
      expect(err).toEqual([]);
    } finally {
      rmSync(join(settingsPath, "..", ".."), { recursive: true, force: true });
    }
  });
});

describe("hasUnstableInstall", () => {
  test("judges the binary and both hook scripts, wherever this checkout lives", () => {
    const scriptsUnstable =
      isUnstableInstallPath(stopHookScriptPath()) || isUnstableInstallPath(promptHookScriptPath());
    expect(hasUnstableInstall("/opt/tempad/src/cli.ts")).toBe(scriptsUnstable);
    expect(hasUnstableInstall("/var/folders/ab/xyz/T/bunx-501-tempad@0.1.0/src/cli.ts")).toBe(true);
  });
});

describe("isUnstableInstallPath", () => {
  test("recognises the scoped bunx layout outside any temp root", () => {
    for (const path of [
      "/home/me/cache/bunx-1000-@hyperlab.sh/tempad@0.1.0/node_modules/@hyperlab.sh/tempad/src/cli.ts",
      "/home/me/cache/bunx-501-@hyperlab.sh/tempad@latest/node_modules/@hyperlab.sh/tempad/hooks/w5-stop.sh",
    ]) {
      expect(isUnstableInstallPath(path)).toBe(true);
    }
    expect(
      isUnstableInstallPath(
        "/home/me/.bun/install/global/node_modules/@hyperlab.sh/tempad/src/cli.ts",
      ),
    ).toBe(false);
  });

  test("recognises bunx directories, bun's cache and temp directories", () => {
    for (const path of [
      "/tmp/bunx-1000-tempad@latest/node_modules/tempad/src/cli.ts",
      "/var/folders/ab/xyz/T/bunx-501-tempad@0.1.0/node_modules/tempad/hooks/w5-stop.sh",
      "/tmp/bunx-501-@hyperlab.sh/tempad@latest/node_modules/@hyperlab.sh/tempad/src/cli.ts",
      "/var/folders/ab/xyz/T/bunx-501-@hyperlab.sh/tempad@0.1.0/node_modules/@hyperlab.sh/tempad/hooks/w5-stop.sh",
      "/Users/me/.bun/install/cache/tempad@0.1.0@@@1/src/cli.ts",
      "/private/var/folders/ab/T/anything/cli.ts",
      "/tmp/checkout/cli.ts",
      join(tmpdir(), "somewhere", "cli.ts"),
    ]) {
      expect(isUnstableInstallPath(path)).toBe(true);
    }
  });

  test("accepts a checkout and a global install", () => {
    for (const path of [
      "/work/tempad/worktrees/main/packages/core/src/cli.ts",
      "/Users/me/.bun/install/global/node_modules/tempad/src/cli.ts",
      "/home/me/code/bunx-notes/cli.ts",
      "/opt/tempad/src/cli.ts",
    ]) {
      expect(isUnstableInstallPath(path)).toBe(false);
    }
  });
});

describe("w5 hook settings location", () => {
  const BIN = "/opt/tempad/src/cli.ts";

  function hasMarker(path: string): boolean {
    return existsSync(path) && /"tempad"\s*:\s*true/.test(readFileSync(path, "utf8"));
  }

  test("user scope follows CLAUDE_CONFIG_DIR when it is set", () => {
    const configDir = mkdtempSync(join(tmpdir(), "tempad-config-dir-"));
    const { code, out, home, settingsPath } = runHookCommand(["install", "--bin", BIN], {
      configDir,
    });
    try {
      expect(code).toBe(0);
      expect(hasMarker(join(configDir, "settings.json"))).toBe(true);
      expect(existsSync(settingsPath)).toBe(false);
      expect(out).toContain(`installed tempad hooks in ${join(configDir, "settings.json")}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("uninstall finds and removes the hooks under CLAUDE_CONFIG_DIR", () => {
    const configDir = mkdtempSync(join(tmpdir(), "tempad-config-dir-"));
    const installed = runHookCommand(["install", "--bin", BIN], { configDir });
    try {
      expect(hasMarker(join(configDir, "settings.json"))).toBe(true);
      const removed = runHookCommand(["uninstall"], { configDir, home: installed.home });
      expect(removed.code).toBe(0);
      expect(hasMarker(join(configDir, "settings.json"))).toBe(false);
      expect(removed.out).toContain(
        `removed tempad hooks from ${join(configDir, "settings.json")}`,
      );

      const again = runHookCommand(["uninstall"], { configDir, home: installed.home });
      expect(again.out).toEqual([
        `no tempad hooks in ${join(configDir, "settings.json")}; nothing changed`,
      ]);
    } finally {
      rmSync(installed.home, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("without CLAUDE_CONFIG_DIR, or with it empty, user scope is $HOME/.claude", () => {
    for (const configDir of [undefined, ""]) {
      const { code, out, home, settingsPath } = runHookCommand(["install", "--bin", BIN], {
        configDir,
      });
      try {
        expect(code).toBe(0);
        expect(hasMarker(settingsPath)).toBe(true);
        expect(out).toContain(`installed tempad hooks in ${settingsPath}`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  test("hooks installed in HOME are not touched when CLAUDE_CONFIG_DIR points elsewhere", () => {
    const configDir = mkdtempSync(join(tmpdir(), "tempad-config-dir-"));
    const installed = runHookCommand(["install", "--bin", BIN]);
    try {
      const removed = runHookCommand(["uninstall"], { configDir, home: installed.home });
      expect(removed.out[0]).toContain("nothing changed");
      expect(hasMarker(installed.settingsPath)).toBe(true);
    } finally {
      rmSync(installed.home, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("project scope ignores CLAUDE_CONFIG_DIR", () => {
    expect(settingsPathFor("project", { CLAUDE_CONFIG_DIR: "/somewhere", HOME: "/home/x" })).toBe(
      join(process.cwd(), ".claude", "settings.json"),
    );
    expect(settingsPathFor("user", { CLAUDE_CONFIG_DIR: "/somewhere", HOME: "/home/x" })).toBe(
      "/somewhere/settings.json",
    );
    expect(settingsPathFor("user", { HOME: "/home/x" })).toBe("/home/x/.claude/settings.json");
  });
});

describe("w5 backfill with the api backend reads ANTHROPIC_API_KEY from TEMPAD_HOME/.env", () => {
  async function backfillOutput(dir: string): Promise<{ code: number; output: string[] }> {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const intentConfig = defaultIntentConfig();
    intentConfig.w5.backend = "api";
    const output: string[] = [];
    const code = await runW5Command(["backfill"], {
      database,
      config: makeConfig(dir),
      intentConfig,
      stdout: (line) => output.push(line),
      spawn: () => {},
    });
    return { code, output };
  }

  test("missing from both the environment and .env: refuses naming the variable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    const previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { code, output } = await backfillOutput(dir);
      expect(code).toBe(1);
      expect(output).toContain("ANTHROPIC_API_KEY not set");
    } finally {
      if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("present only in TEMPAD_HOME/.env: accepted, and never printed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    const previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-secret-from-file\n");
      const { output } = await backfillOutput(dir);
      expect(output).not.toContain("ANTHROPIC_API_KEY not set");
      expect(output.join("\n")).not.toContain("sk-secret-from-file");
    } finally {
      if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w5 backfill --from", () => {
  const DAY = 86_400_000;

  async function run(args: string[], seed?: (database: ReturnType<typeof openDatabase>) => void) {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    const database = openDatabase(":memory:");
    ensureTables(database);
    seed?.(database);
    const intentConfig = defaultIntentConfig();
    // A classifier that always fails: an attempted window shows up as `failed=1`, a skipped one as nothing.
    intentConfig.w5.claudeCommand = "/usr/bin/false";
    const output: string[] = [];
    try {
      const code = await runW5Command(["backfill", ...args], {
        database,
        config: makeConfig(dir),
        intentConfig,
        stdout: (line) => output.push(line),
        spawn: () => {},
      });
      return { code, output: output.join("\n") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function seedSession(database: ReturnType<typeof openDatabase>, endedAt: string) {
    database
      .query(
        `INSERT INTO claude_sessions
          (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
           started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 't', 'main', ?, ?, 1, 0, '[]', 'host', ?)`,
      )
      .run(endedAt, endedAt, endedAt);
    database
      .query(
        "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES ('m1', 's1', ?, 'user', 0, 'work')",
      )
      .run(endedAt);
  }

  test("a session that ended after --from is classified; one before it is not", async () => {
    const endedAt = new Date(Date.now() - 2 * DAY).toISOString();
    const seed = (database: ReturnType<typeof openDatabase>) => seedSession(database, endedAt);
    const included = await run(["--from", new Date(Date.now() - 3 * DAY).toISOString()], seed);
    expect(included.output).toContain("failed=1");
    const excluded = await run(["--from", new Date(Date.now() - DAY).toISOString()], seed);
    expect(excluded.code).toBe(0);
    expect(excluded.output).toBe("classified=0 windows=0 failed=0 skipped=0 windows_skipped=0");
  });

  test("the lower bound is inclusive: a session ending exactly at --from is classified", async () => {
    const endedAt = new Date(Date.now() - 2 * DAY).toISOString();
    const result = await run(["--from", endedAt], (database) => seedSession(database, endedAt));
    expect(result.output).toContain("failed=1");
  });

  test("--from beats the default 15-day window, which would also have reached the session", async () => {
    const endedAt = new Date(Date.now() - 2 * DAY).toISOString();
    const result = await run(["--from", new Date(Date.now() - 1 * DAY).toISOString()], (database) =>
      seedSession(database, endedAt),
    );
    expect(result.output).not.toContain("failed=1");
  });

  test("an offset timestamp is read as the instant it names", async () => {
    // 2 days ago, written with a +03:00 offset: the same instant as the session's end.
    const ended = Date.now() - 2 * DAY;
    const endedAt = new Date(ended).toISOString();
    const offset = new Date(ended + 3 * 3_600_000).toISOString().replace("Z", "+03:00");
    const result = await run(["--from", offset], (database) => seedSession(database, endedAt));
    expect(result.output).toContain("failed=1");
  });

  for (const bad of [
    "yesterday",
    "",
    "2026-13-45",
    "2026-02-30",
    "2026-02-30T10:00:00Z",
    "2026-04-31T10:00:00+02:00",
    "not a date",
    "1",
    "Oct 1",
    "2026-10",
    "2026-10-01 10:00",
    "2026-10-01 10:00:00",
    "2026-10-01T10:00:00",
    "2026-10-01T10:00:00+0300",
    "20261001",
  ]) {
    test(`--from ${JSON.stringify(bad)} is a usage error (exit 2)`, async () => {
      const result = await run(["--from", bad]);
      expect(result.code).toBe(2);
      expect(result.output).toContain("usage: tempad w5 backfill");
      expect(result.output).toContain("--from needs an ISO 8601 date or datetime");
    });
  }

  // A range can no longer be retracted on the real database.
  for (const flag of [
    ["--reclassify"],
    ["--to", "2026-10-02"],
    ["--backup", "x.db"],
    ["--dry-run"],
  ]) {
    test(`${flag[0]} is an unknown flag like any other`, async () => {
      await expect(run(["--from", "2026-10-01", ...flag])).rejects.toThrow(flag[0] as string);
    });
  }

  for (const good of [
    "2026-10-01",
    "2026-10-01T10:00:00Z",
    "2026-10-01T10:00:00.123Z",
    "2026-10-01T10:00:00-03:00",
    "2026-10-01T10:00:00.5+05:30",
    "2026-10-01T23:30:00-03:00",
    "2024-02-29T10:00:00Z",
  ]) {
    test(`--from ${good} is accepted`, async () => {
      const result = await run(["--from", good]);
      expect(result.code).toBe(0);
    });
  }

  test("a datetime whose offset moves it to the next UTC day keeps the instant", async () => {
    // 2026-10-01 23:30 at -03:00 is 2026-10-02 02:30 UTC.
    const endedAt = "2026-10-02T02:30:00.000Z";
    const at = await run(["--from", "2026-10-01T23:30:00-03:00"], (database) =>
      seedSession(database, endedAt),
    );
    expect(at.output).toContain("failed=1");
    const after = await run(["--from", "2026-10-01T23:30:01-03:00"], (database) =>
      seedSession(database, endedAt),
    );
    expect(after.output).not.toContain("failed=1");
  });

  test("a date-only --from names midnight UTC of that day", async () => {
    const day = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
    const endedAt = `${day}T00:00:00.000Z`;
    const included = await run(["--from", day], (database) => seedSession(database, endedAt));
    expect(included.output).toContain("failed=1");
    const next = new Date(Date.parse(endedAt) + DAY).toISOString().slice(0, 10);
    const excluded = await run(["--from", next], (database) => seedSession(database, endedAt));
    expect(excluded.output).not.toContain("failed=1");
  });

  test("--from with --days is a usage error (exit 2), whichever order", async () => {
    for (const args of [
      ["--from", "2026-10-01T00:00:00Z", "--days", "5"],
      ["--days", "5", "--from", "2026-10-01T00:00:00Z"],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.output).toContain("cannot be combined");
    }
  });

  test("--from needs a value", async () => {
    await expect(run(["--from"])).rejects.toThrow();
  });
});

describe("w5 hook install|uninstall with an unparseable settings.json", () => {
  for (const [label, content] of [
    ["invalid JSON", "{ not json"],
    ["a non-object top level", "[1, 2]"],
    ["null", "null"],
  ] as const) {
    for (const action of ["install", "uninstall"] as const) {
      test(`${action} exits 1 naming the file and leaves it untouched (${label})`, () => {
        const home = mkdtempSync(join(tmpdir(), "tempad-hook-cli-"));
        const settingsPath = join(home, ".claude", "settings.json");
        mkdirSync(join(home, ".claude"), { recursive: true });
        writeFileSync(settingsPath, content);
        try {
          const args =
            action === "install" ? ["install", "--bin", "/opt/tempad/src/cli.ts"] : ["uninstall"];
          const result = runHookCommand(args, { home });
          expect(result.code).toBe(1);
          expect(result.err.join("\n")).toContain(settingsPath);
          expect(result.err.join("\n")).toContain("not valid JSON");
          expect(result.err.join("\n")).not.toContain("    at ");
          expect(readFileSync(settingsPath, "utf8")).toBe(content);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }
});
