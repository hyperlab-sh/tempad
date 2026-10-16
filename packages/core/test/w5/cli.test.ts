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
  isUnstableInstallPath,
  PLUGIN_RECOMMENDATION_MESSAGE,
  UNSTABLE_INSTALL_MESSAGE,
} from "../../src/w5/hooks";

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
      writeFileSync(lockPath, "12345");
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

describe("w5 run stale lock", () => {
  test("removes a lock older than 30 minutes and continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      const lockPath = join(dir, "w5.lock");
      writeFileSync(lockPath, "12345");
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
      const declare = (done = false, questId?: string) =>
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
      return { database, store, declare };
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
      const { database, declare } = seedAsked();
      declare();

      const output = await contextOutput(database);

      expect(output).toContain("active quests: Ship X [Q1]");
      expect(output).not.toContain("no declared quest");
    });

    test("it is still rendered with no declaration", async () => {
      const { database } = seedAsked();
      const output = await contextOutput(database);
      expect(output).toContain("active quests: none");
      expect(output).toContain("w5 has no declared quest for this session");
    });

    test("it is still rendered when the only declared quest was ended", async () => {
      const { database, declare } = seedAsked();
      const { questId } = declare();
      declare(true, questId);

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
  options: { configDir?: string; home?: string } = {},
): {
  code: number;
  out: string[];
  err: string[];
  home: string;
  settingsPath: string;
} {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "tempad-hook-cli-"));
  const settingsPath = join(home, ".claude", "settings.json");
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const savedLog = console.log;
  const savedError = console.error;
  const out: string[] = [];
  const err: string[] = [];
  process.env.HOME = home;
  if (options.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = options.configDir;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    return { code: runW5HookCommand(args), out, err, home, settingsPath };
  } finally {
    console.log = savedLog;
    console.error = savedError;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
