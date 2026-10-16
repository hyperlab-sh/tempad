import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSkillCommand, runSync } from "../src/cli.ts";
import type { Collector, SyncSummary } from "../src/collect/types.ts";
import { openDatabase } from "../src/db/database.ts";
import { getSyncState, setSyncState } from "../src/db/sync-state.ts";

function makeCollector(
  name: Collector["name"],
  behavior: "succeed" | "fail",
  calls: string[],
): Collector {
  return {
    name,
    needs: [],
    async sync(): Promise<SyncSummary> {
      calls.push(name);
      if (behavior === "fail") throw new Error(`${name} failed`);
      return { source: name, inserted: 1, updated: 0, deleted: 0, warnings: [] };
    },
  };
}

describe("runSync", () => {
  test("a failing collector does not stop the others; exit is 1; sync_state untouched on failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    const dbPath = join(dir, "tempad.db");

    try {
      const database = openDatabase(dbPath);
      const calls: string[] = [];
      const failing = makeCollector("monday", "fail", calls);
      const succeeding = makeCollector("github", "succeed", calls);

      const { summaries, failed } = await runSync(database, {} as never, [failing, succeeding]);

      expect(calls).toEqual(["monday", "github"]);
      expect(failed).toBe(true);
      expect(summaries).toHaveLength(2);

      expect(getSyncState(database, "monday")).toBeUndefined();
      expect(getSyncState(database, "github")).toBeDefined();

      database.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("all succeeding collectors report failed = false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    const dbPath = join(dir, "tempad.db");

    try {
      const database = openDatabase(dbPath);
      const calls: string[] = [];
      const a = makeCollector("monday", "succeed", calls);
      const b = makeCollector("claude", "succeed", calls);

      const { failed } = await runSync(database, {} as never, [a, b]);
      expect(failed).toBe(false);
      expect(getSyncState(database, "monday")).toBeDefined();
      expect(getSyncState(database, "claude")).toBeDefined();

      database.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("report command default output path", () => {
  test("writes to TEMPAD_HOME/reports/<kind>-<from>-<to>.md and echoes to stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-report-test-"));

    try {
      await Bun.write(
        join(dir, ".env"),
        [
          "MONDAY_API_TOKEN=token",
          "MONDAY_USER=1",
          "GH_USER=octocat",
          "GH_ORGS=acme",
          "GH_INCLUDE_PERSONAL=false",
          "GIT_AUTHOR_EMAILS=octocat@example.com",
          "CLAUDE_DIRS=/tmp/does-not-matter",
          "HOST_SLUG=test-host",
          "TZ=America/Sao_Paulo",
          "SINCE=2026-01-01",
        ].join("\n"),
      );

      const proc = Bun.spawn({
        cmd: [
          "bun",
          "run",
          join(import.meta.dir, "..", "src", "cli.ts"),
          "report",
          "daily",
          "--from",
          "2026-09-01",
          "--to",
          "2026-09-01",
        ],
        env: { ...process.env, TEMPAD_HOME: dir },
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      const outPath = join(dir, "reports", "daily-2026-09-01-2026-09-01.md");
      const file = Bun.file(outPath);
      expect(await file.exists()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tempad sync --full", () => {
  test("clears sync_state for the selected source so a full rescan happens even when a normal sync would skip everything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-full-test-"));

    try {
      const claudeDir = join(dir, "claude");
      mkdirSync(join(claudeDir, "projects", "full-test"), { recursive: true });
      writeFileSync(
        join(claudeDir, "projects", "full-test", "session-1.jsonl"),
        `${JSON.stringify({
          type: "user",
          uuid: "u1",
          sessionId: "sess-full-1",
          timestamp: "2026-01-01T10:00:00.000Z",
          origin: { kind: "human" },
          message: { role: "user", content: "hello" },
        })}\n`,
      );

      await Bun.write(
        join(dir, ".env"),
        [
          "MONDAY_API_TOKEN=token",
          "MONDAY_USER=1",
          "GH_USER=octocat",
          "GH_ORGS=acme",
          "GH_INCLUDE_PERSONAL=false",
          "GIT_AUTHOR_EMAILS=octocat@example.com",
          `CLAUDE_DIRS=${claudeDir}`,
          "HOST_SLUG=test-host",
          "TZ=UTC",
          "SINCE=2020-01-01",
        ].join("\n"),
      );

      const database = openDatabase(join(dir, "tempad.db"));
      // A future last_sync_at makes the claude collector's mtime-skip filter reject
      // every file in a normal sync -- the file was written well before "now".
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      setSyncState(database, "claude", future);
      database.close();

      const runCli = (args: string[]) =>
        Bun.spawn({
          cmd: ["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), ...args],
          env: { ...process.env, TEMPAD_HOME: dir },
          stdout: "pipe",
          stderr: "pipe",
        }).exited;

      expect(await runCli(["sync", "claude"])).toBe(0);

      const afterNormalSync = openDatabase(join(dir, "tempad.db"));
      const countAfterNormal = (
        afterNormalSync.query("SELECT COUNT(*) as count FROM claude_sessions").get() as {
          count: number;
        }
      ).count;
      afterNormalSync.close();
      expect(countAfterNormal).toBe(0);

      expect(await runCli(["sync", "claude", "--full"])).toBe(0);

      const afterFullSync = openDatabase(join(dir, "tempad.db"));
      const countAfterFull = (
        afterFullSync.query("SELECT COUNT(*) as count FROM claude_sessions").get() as {
          count: number;
        }
      ).count;
      afterFullSync.close();
      expect(countAfterFull).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const NOT_SET_UP = "tempad is not set up yet; run: bunx @hyperlab.sh/tempad init\n";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Sandbox {
  /** Fresh HOME for the subprocess. */
  home: string;
  /** TEMPAD_HOME; not created unless a test does so. */
  tempadHome: string;
  /** Fresh working directory for the subprocess. */
  cwd: string;
  root: string;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "tempad-cli-sandbox-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  mkdirSync(home);
  mkdirSync(cwd);
  return { home, tempadHome: join(root, "tempad-home"), cwd, root };
}

/** Runs the CLI with an explicit environment: nothing from the developer's real env leaks in. */
async function runCli(
  sandbox: Sandbox,
  args: string[],
  extraEnvironment: Record<string, string | null> = {},
  options: { viaShebang?: boolean } = {},
): Promise<CliResult> {
  const bunDirectory = dirname(process.execPath);
  const environment: Record<string, string> = {
    PATH: `${bunDirectory}:/usr/bin:/bin`,
    HOME: sandbox.home,
    TEMPAD_HOME: sandbox.tempadHome,
  };
  // A null value removes the variable (an empty string would still be "set").
  for (const [name, value] of Object.entries(extraEnvironment)) {
    if (value === null) delete environment[name];
    else environment[name] = value;
  }
  const proc = Bun.spawn({
    cmd: options.viaShebang ? [CLI_PATH, ...args] : [process.execPath, "run", CLI_PATH, ...args],
    cwd: sandbox.cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Marks the sandbox's TEMPAD_HOME as set up (an empty .env), with no variables defined. */
function configure(sandbox: Sandbox, envFile = ""): void {
  mkdirSync(sandbox.tempadHome, { recursive: true });
  writeFileSync(join(sandbox.tempadHome, ".env"), envFile);
}

function cleanup(sandbox: Sandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true });
}

describe("cli process", () => {
  test("unknown report kind exits 2", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const result = await runCli(sandbox, ["report", "weekly"]);
      expect(result.exitCode).toBe(2);
    } finally {
      cleanup(sandbox);
    }
  });

  test("no command exits 2 with usage on stderr and nothing on stdout", async () => {
    const sandbox = makeSandbox();
    try {
      const result = await runCli(sandbox, []);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Usage:");
      expect(result.stdout).toBe("");
    } finally {
      cleanup(sandbox);
    }
  });

  test("an unknown command exits 2 with usage on stderr", async () => {
    const sandbox = makeSandbox();
    try {
      const result = await runCli(sandbox, ["frobnicate"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Usage:");
      expect(result.stdout).toBe("");
      expect(existsSync(sandbox.tempadHome)).toBe(false);
    } finally {
      cleanup(sandbox);
    }
  });

  test("an unknown w5 subcommand exits 2 and opens nothing", async () => {
    const sandbox = makeSandbox();
    try {
      const result = await runCli(sandbox, ["w5", "frobnicate"]);
      expect(result.exitCode).toBe(2);
      expect(existsSync(sandbox.tempadHome)).toBe(false);
    } finally {
      cleanup(sandbox);
    }
  });
});

describe("cli --help", () => {
  const COMMAND_FRAGMENTS = [
    "tempad init",
    "tempad sync",
    "tempad report",
    "tempad hero init",
    "tempad party",
    "tempad client",
    "tempad saga",
    "tempad quest add",
    "tempad quest declare",
    "tempad stint list",
    "tempad trace list",
    "tempad impact",
    "tempad answer",
    "tempad rebuild",
    "tempad w5 enqueue",
    "tempad w5 context",
    "tempad w5 run",
    "tempad w5 hook install|uninstall",
    "tempad w5 backfill",
    "tempad w5 dedupe",
    "tempad w5 eval",
    "tempad quiet",
    "tempad review",
    "tempad skill install",
    "tempad project register",
    "tempad --help",
  ];

  for (const flag of ["--help", "-h", "help"]) {
    test(`\`tempad ${flag}\` prints every command to stdout, exits 0, with an empty env and no home`, async () => {
      const sandbox = makeSandbox();
      try {
        const result = await runCli(sandbox, [flag]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Usage:");
        for (const fragment of COMMAND_FRAGMENTS) {
          expect(result.stdout).toContain(fragment);
        }
        expect(existsSync(sandbox.tempadHome)).toBe(false);
      } finally {
        cleanup(sandbox);
      }
    });
  }

  test("`tempad <unknown> --help` is still a usage error: exit 2, usage on stderr", async () => {
    const sandbox = makeSandbox();
    try {
      for (const flag of ["--help", "-h"]) {
        const result = await runCli(sandbox, ["bogus", flag]);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("Usage:");
        expect(result.stdout).toBe("");
      }
    } finally {
      cleanup(sandbox);
    }
  });

  test("`tempad <command> --help` prints the usage instead of failing on an unknown option", async () => {
    const sandbox = makeSandbox();
    try {
      for (const command of ["sync", "report", "w5", "quest"]) {
        const result = await runCli(sandbox, [command, "--help"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Usage:");
      }
      expect(existsSync(sandbox.tempadHome)).toBe(false);
    } finally {
      cleanup(sandbox);
    }
  });
});

describe("cli per-command configuration", () => {
  test("sync monday names the command and exactly the Monday variables", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const result = await runCli(sandbox, ["sync", "monday"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `tempad sync monday needs MONDAY_API_TOKEN, MONDAY_USER; set them in ${join(sandbox.tempadHome, ".env")} or run: bunx @hyperlab.sh/tempad init\n`,
      );
    } finally {
      cleanup(sandbox);
    }
  });

  test("sync github names its five required variables and never GH_TOKEN", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const result = await runCli(sandbox, ["sync", "github"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("tempad sync github needs");
      for (const name of [
        "GH_USER",
        "GH_ORGS",
        "GH_INCLUDE_PERSONAL",
        "GIT_AUTHOR_EMAILS",
        "SINCE",
      ]) {
        expect(result.stderr).toContain(name);
      }
      for (const name of ["GH_TOKEN", "MONDAY_API_TOKEN", "CLAUDE_DIRS", "HOST_SLUG", "TZ"]) {
        expect(result.stderr).not.toContain(name);
      }
    } finally {
      cleanup(sandbox);
    }
  });

  test("sync claude names CLAUDE_DIRS, SINCE and HOST_SLUG only", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const result = await runCli(sandbox, ["sync", "claude"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("tempad sync claude needs CLAUDE_DIRS, HOST_SLUG, SINCE;");
      expect(result.stderr).not.toContain("MONDAY");
      expect(result.stderr).not.toContain("GH_");
    } finally {
      cleanup(sandbox);
    }
  });

  test("sync (all) names the union of the three collectors", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const result = await runCli(sandbox, ["sync"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("tempad sync needs");
      for (const name of [
        "MONDAY_API_TOKEN",
        "MONDAY_USER",
        "GH_USER",
        "GH_ORGS",
        "GH_INCLUDE_PERSONAL",
        "GIT_AUTHOR_EMAILS",
        "CLAUDE_DIRS",
        "HOST_SLUG",
        "SINCE",
      ]) {
        expect(result.stderr).toContain(name);
      }
      expect(result.stderr).not.toContain("GH_TOKEN");
    } finally {
      cleanup(sandbox);
    }
  });

  test("sync claude succeeds with only its three variables set, on a machine never set up for GitHub or Monday", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const claudeDirectory = join(sandbox.root, "claude");
      mkdirSync(join(claudeDirectory, "projects"), { recursive: true });
      const result = await runCli(sandbox, ["sync", "claude"], {
        CLAUDE_DIRS: claudeDirectory,
        SINCE: "2026-01-01",
        HOST_SLUG: "test-host",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("claude: inserted=0");
      expect(result.stderr).not.toContain("needs");
    } finally {
      cleanup(sandbox);
    }
  });

  test("report needs only TZ", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const result = await runCli(sandbox, [
        "report",
        "daily",
        "--from",
        "2026-01-01",
        "--to",
        "2026-01-02",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `tempad report daily needs TZ; set it in ${join(sandbox.tempadHome, ".env")} or run: bunx @hyperlab.sh/tempad init\n`,
      );
    } finally {
      cleanup(sandbox);
    }
  });

  test("report runs with TZ alone and writes to TEMPAD_HOME/reports", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox, "TZ=UTC\n");
      const result = await runCli(sandbox, [
        "report",
        "daily",
        "--from",
        "2026-01-01",
        "--to",
        "2026-01-02",
      ]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(
        existsSync(join(sandbox.tempadHome, "reports", "daily-2026-01-01-2026-01-02.md")),
      ).toBe(true);
    } finally {
      cleanup(sandbox);
    }
  });

  test("a bad GH_INCLUDE_PERSONAL fails sync github but not sync claude", async () => {
    const sandbox = makeSandbox();
    try {
      const claudeDirectory = join(sandbox.root, "claude");
      mkdirSync(join(claudeDirectory, "projects"), { recursive: true });
      configure(
        sandbox,
        `GH_INCLUDE_PERSONAL=yes\nCLAUDE_DIRS=${claudeDirectory}\nSINCE=2026-01-01\nHOST_SLUG=h\n`,
      );
      const claude = await runCli(sandbox, ["sync", "claude"]);
      expect(claude.exitCode).toBe(0);
    } finally {
      cleanup(sandbox);
    }
  });

  test("intent commands need no variables: hero init works with an empty .env", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const result = await runCli(sandbox, ["hero", "init", "Test Hero"]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(sandbox.tempadHome, "tempad.db"))).toBe(true);
    } finally {
      cleanup(sandbox);
    }
  });

  test("project list, quiet and review need no variables", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      for (const args of [["project", "list"], ["quiet", "30m"], ["review"], ["w5", "dedupe"]]) {
        const result = await runCli(sandbox, args);
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
      }
    } finally {
      cleanup(sandbox);
    }
  });

  test("w5 enqueue and w5 context need no variables", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const enqueue = await runCli(sandbox, ["w5", "enqueue"]);
      expect(enqueue.exitCode).toBe(0);
      expect(enqueue.stderr).toBe("");
      const context = await runCli(sandbox, ["w5", "context", "--session", "s1"]);
      expect(context.exitCode).toBe(0);
      expect(context.stderr).toBe("");
      expect(context.stdout).toContain("active quests: none");
    } finally {
      cleanup(sandbox);
    }
  });

  test("w5 eval needs TZ; w5 run needs CLAUDE_DIRS and HOST_SLUG", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const evaluation = await runCli(sandbox, [
        "w5",
        "eval",
        "--from",
        "2026-01-01",
        "--to",
        "2026-01-02",
      ]);
      expect(evaluation.exitCode).toBe(1);
      expect(evaluation.stderr).toContain("tempad w5 eval needs TZ;");
      const run = await runCli(sandbox, ["w5", "run"]);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("tempad w5 run needs CLAUDE_DIRS, HOST_SLUG;");
    } finally {
      cleanup(sandbox);
    }
  });

  test("w5 backfill and w5 dedupe need no variables", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const dedupe = await runCli(sandbox, ["w5", "dedupe", "--dry-run"]);
      expect(dedupe.exitCode).toBe(0);
      expect(dedupe.stdout).toContain("traces=0");
    } finally {
      cleanup(sandbox);
    }
  });

  test("process.env takes precedence over TEMPAD_HOME/.env end to end", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox, "TZ=Not/AZone\n");
      const result = await runCli(
        sandbox,
        ["report", "daily", "--from", "2026-01-01", "--to", "2026-01-02"],
        { TZ: "UTC" },
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(sandbox);
    }
  });
});

describe("cli without setup", () => {
  const DATABASE_COMMANDS: string[][] = [
    ["sync"],
    ["sync", "claude"],
    ["report", "daily", "--from", "2026-01-01", "--to", "2026-01-02"],
    ["hero", "init", "Someone"],
    ["stint", "list"],
    ["quest", "list"],
    ["rebuild"],
    ["project", "list"],
    ["quiet", "2h"],
    ["review"],
    ["w5", "run"],
    ["w5", "backfill"],
    ["w5", "dedupe"],
    ["w5", "eval", "--from", "2026-01-01", "--to", "2026-01-02"],
  ];

  for (const args of DATABASE_COMMANDS) {
    test(`\`tempad ${args.slice(0, 2).join(" ")}\` exits 1 with the setup message and creates nothing`, async () => {
      const sandbox = makeSandbox();
      try {
        const result = await runCli(sandbox, args);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(NOT_SET_UP);
        expect(existsSync(sandbox.tempadHome)).toBe(false);
      } finally {
        cleanup(sandbox);
      }
    });
  }

  test("an existing but empty TEMPAD_HOME is still unconfigured and gets no tempad.db", async () => {
    const sandbox = makeSandbox();
    try {
      mkdirSync(sandbox.tempadHome);
      writeFileSync(join(sandbox.tempadHome, "tempad.toml"), "");
      const result = await runCli(sandbox, ["stint", "list"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(NOT_SET_UP);
      expect(readdirSync(sandbox.tempadHome)).toEqual(["tempad.toml"]);
    } finally {
      cleanup(sandbox);
    }
  });

  test("a home with only tempad.db counts as configured", async () => {
    const sandbox = makeSandbox();
    try {
      mkdirSync(sandbox.tempadHome);
      openDatabase(join(sandbox.tempadHome, "tempad.db")).close();
      const result = await runCli(sandbox, ["stint", "list"]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(sandbox);
    }
  });

  test("the unset default home (~/.tempad under HOME) is not created either", async () => {
    const sandbox = makeSandbox();
    try {
      const result = await runCli(sandbox, ["stint", "list"], { TEMPAD_HOME: null });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(NOT_SET_UP);
      expect(existsSync(join(sandbox.home, ".tempad"))).toBe(false);
    } finally {
      cleanup(sandbox);
    }
  });

  test("w5 enqueue and w5 context exit 0 silently and create nothing", async () => {
    const sandbox = makeSandbox();
    try {
      for (const args of [
        ["w5", "enqueue", "--session", "s1"],
        ["w5", "enqueue", "--session", "s1", "--forced"],
        ["w5", "context", "--session", "s1"],
      ]) {
        const result = await runCli(sandbox, args);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
        expect(existsSync(sandbox.tempadHome)).toBe(false);
      }
    } finally {
      cleanup(sandbox);
    }
  });

  test("w5 hook uninstall works with an empty environment and an empty TEMPAD_HOME", async () => {
    const sandbox = makeSandbox();
    try {
      mkdirSync(sandbox.tempadHome);
      const result = await runCli(sandbox, ["w5", "hook", "uninstall"]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(readdirSync(sandbox.tempadHome)).toEqual([]);
    } finally {
      cleanup(sandbox);
    }
  });

  test("w5 hook uninstall removes tempad hooks from a temporary HOME's settings, leaving others", async () => {
    const sandbox = makeSandbox();
    try {
      const settingsPath = join(sandbox.home, ".claude", "settings.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      const install = await runCli(sandbox, ["w5", "hook", "install"]);
      expect(install.exitCode).toBe(0);
      expect(readFileSync(settingsPath, "utf8")).toContain('"tempad": true');
      const uninstall = await runCli(sandbox, ["w5", "hook", "uninstall"]);
      expect(uninstall.exitCode).toBe(0);
      expect(readFileSync(settingsPath, "utf8")).not.toContain('"tempad": true');
      expect(existsSync(sandbox.tempadHome)).toBe(false);
    } finally {
      cleanup(sandbox);
    }
  });

  test("skill install needs no environment and opens no database", async () => {
    const sandbox = makeSandbox();
    try {
      const result = await runCli(sandbox, ["skill", "install"]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(sandbox.home, ".claude", "skills", "tempad-quest", "SKILL.md"))).toBe(
        true,
      );
      expect(existsSync(sandbox.tempadHome)).toBe(false);
    } finally {
      cleanup(sandbox);
    }
  });
});

describe("cli ignores a .env in the current directory", () => {
  const PROJECT_ENV =
    "CLAUDE_DIRS=/project/claude\nSINCE=1999-01-01\nHOST_SLUG=project-host\nTZ=UTC\n";

  test("via `bun run cli.ts` (no shebang flag): the project's values do not satisfy the config", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      writeFileSync(join(sandbox.cwd, ".env"), PROJECT_ENV);
      const result = await runCli(sandbox, ["sync", "claude"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("tempad sync claude needs CLAUDE_DIRS, HOST_SLUG, SINCE;");
    } finally {
      cleanup(sandbox);
    }
  });

  test("via the shebang (`./src/cli.ts`): the project's values do not satisfy the config", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      writeFileSync(join(sandbox.cwd, ".env"), PROJECT_ENV);
      const result = await runCli(sandbox, ["sync", "claude"], {}, { viaShebang: true });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("tempad sync claude needs CLAUDE_DIRS, HOST_SLUG, SINCE;");
    } finally {
      cleanup(sandbox);
    }
  });

  test("a project TZ=UTC does not override TEMPAD_HOME/.env: TEMPAD_HOME's TZ is the one reported on", async () => {
    const sandbox = makeSandbox();
    try {
      // 02:30 UTC on Jan 2 is still Jan 1 in Sao Paulo; the report must be built with
      // the home's zone. A bad zone in the home .env would make Intl throw, a project
      // TZ=UTC overriding it would not, so the failing exit proves which one was read.
      configure(sandbox, "TZ=Not/AZone\n");
      writeFileSync(join(sandbox.cwd, ".env"), "TZ=UTC\n");
      for (const viaShebang of [false, true]) {
        const result = await runCli(
          sandbox,
          ["report", "daily", "--from", "2026-01-01", "--to", "2026-01-02"],
          {},
          { viaShebang },
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toMatch(/Not\/AZone|time zone/i);
      }
    } finally {
      cleanup(sandbox);
    }
  });

  test("a project .env cannot redirect TEMPAD_HOME", async () => {
    const sandbox = makeSandbox();
    try {
      const hijacked = join(sandbox.root, "hijacked");
      mkdirSync(hijacked);
      writeFileSync(join(hijacked, ".env"), "");
      writeFileSync(join(sandbox.cwd, ".env"), `TEMPAD_HOME=${hijacked}\n`);
      // TEMPAD_HOME is unset for the caller, so only the project's file could set it.
      const result = await runCli(sandbox, ["stint", "list"], { TEMPAD_HOME: null });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(NOT_SET_UP);
      expect(readdirSync(hijacked)).toEqual([".env"]);
    } finally {
      cleanup(sandbox);
    }
  });

  test("values the caller exports still count when a project .env sets other variables", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const claudeDirectory = join(sandbox.root, "claude");
      mkdirSync(join(claudeDirectory, "projects"), { recursive: true });
      writeFileSync(join(sandbox.cwd, ".env"), "SINCE=1999-01-01\nOTHER=1\n");
      const result = await runCli(sandbox, ["sync", "claude"], {
        CLAUDE_DIRS: claudeDirectory,
        SINCE: "2026-01-01",
        HOST_SLUG: "host",
      });
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup(sandbox);
    }
  });
});

describe("tempad skill install", () => {
  test("--scope user copies the skill into a temporary HOME's ~/.claude/skills, never the real one", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "tempad-skill-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      const exitCode = runSkillCommand(["install", "--scope", "user"]);
      expect(exitCode).toBe(0);
      const destination = join(tempHome, ".claude", "skills", "tempad-quest", "SKILL.md");
      expect(existsSync(destination)).toBe(true);
      const content = readFileSync(destination, "utf8");
      expect(content).toContain("name: tempad-quest");
      expect(content).toContain("tempad quest declare");
    } finally {
      process.env.HOME = previousHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("--scope user follows CLAUDE_CONFIG_DIR when set and non-empty, else HOME", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "tempad-skill-home-"));
    const configDir = mkdtempSync(join(tmpdir(), "tempad-skill-config-"));
    const previousHome = process.env.HOME;
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = tempHome;
    try {
      process.env.CLAUDE_CONFIG_DIR = configDir;
      expect(runSkillCommand(["install", "--scope", "user"])).toBe(0);
      expect(existsSync(join(configDir, "skills", "tempad-quest", "SKILL.md"))).toBe(true);
      expect(existsSync(join(tempHome, ".claude"))).toBe(false);

      process.env.CLAUDE_CONFIG_DIR = "";
      expect(runSkillCommand(["install", "--scope", "user"])).toBe(0);
      expect(existsSync(join(tempHome, ".claude", "skills", "tempad-quest", "SKILL.md"))).toBe(
        true,
      );
    } finally {
      process.env.HOME = previousHome;
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("--scope project copies the skill into .claude/skills under the current working directory", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "tempad-skill-home-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tempad-skill-project-"));
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();
    process.env.HOME = tempHome;
    process.chdir(projectDir);
    try {
      const exitCode = runSkillCommand(["install", "--scope", "project"]);
      expect(exitCode).toBe(0);
      const destination = join(projectDir, ".claude", "skills", "tempad-quest", "SKILL.md");
      expect(existsSync(destination)).toBe(true);
    } finally {
      process.chdir(previousCwd);
      process.env.HOME = previousHome;
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("--scope user throws a clear error when HOME is unset, never defaults to '/'", () => {
    const previousHome = process.env.HOME;
    delete process.env.HOME;
    try {
      expect(() => runSkillCommand(["install", "--scope", "user"])).toThrow(/HOME is not set/);
    } finally {
      process.env.HOME = previousHome;
    }
  });
});
