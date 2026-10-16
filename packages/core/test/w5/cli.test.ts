import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
import { planW5Command, runReviewCommand, runW5Command } from "../../src/w5/cli";

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

      const code = await runW5Command(["enqueue", "--session", "s1"], {
        database,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn,
      });

      expect(code).toBe(0);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.detached).toBe(true);
      expect(spawnCalls[0]?.cmd).toContain("w5");
      expect(spawnCalls[0]?.cmd).toContain("run");
      // The detached run inherits the hook's cwd (a user's project); its .env must not load.
      expect(spawnCalls[0]?.cmd).toContain("--no-env-file");
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
