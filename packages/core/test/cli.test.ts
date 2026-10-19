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
import { Glob } from "bun";
import { COMMAND_TREE, runSkillCommand, runSync } from "../src/cli.ts";
import type { Collector, SyncSummary } from "../src/collect/types.ts";
import { openDatabase } from "../src/db/database.ts";
import { getSyncState, setSyncState } from "../src/db/sync-state.ts";
import {
  ANSWER_BELONGS_FORM,
  ANSWER_EXISTING_QUEST_FORM,
  ANSWER_NEW_QUEST_FORM,
  BOOLEAN_FLAGS,
  checkPositionals,
  DECLARE_EXISTING_QUEST_FORM,
  DECLARE_NEW_QUEST_FORM,
  documentedPaths,
  POSITIONAL_LIMITS,
  usageBlock,
  usageForPath,
  usageText,
  walkPath,
} from "../src/usage.ts";
import { renderHookSettings } from "../src/w5/hooks.ts";
import { withEnvironment } from "./isolation.ts";

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
const NOT_SET_UP =
  "tempad is not set up yet; run /tempad:setup in Claude Code, or `tempad setup` in a terminal\n";

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
    "tempad setup",
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

  test("lists setup and leaves the hidden init alias out", async () => {
    const sandbox = makeSandbox();
    try {
      const result = await runCli(sandbox, ["--help"]);
      expect(result.stdout).toContain("tempad setup");
      expect(result.stdout).not.toMatch(/tempad init\b/);
    } finally {
      cleanup(sandbox);
    }
  });

  test("--version prints the package version without a home", async () => {
    const sandbox = makeSandbox();
    try {
      const result = await runCli(sandbox, ["--version"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(
        (
          JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
            version: string;
          }
        ).version,
      );
      expect(existsSync(sandbox.tempadHome)).toBe(false);
    } finally {
      cleanup(sandbox);
    }
  });

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

/**
 * Every file and directory under `directory`, relative, sorted: a cheap snapshot to compare.
 * Bun's own cache (`~/Library/Caches/bun` on macOS, `~/.bun/install/cache` on Linux) is left
 * out, since the runtime fills it whatever the CLI does.
 */
const BUN_CACHE_PATHS = ["Library/Caches/bun", ".bun/install/cache"];

function listTree(directory: string): string[] {
  return (readdirSync(directory, { recursive: true }) as string[])
    .map(String)
    .filter((path) => {
      if (BUN_CACHE_PATHS.some((cache) => path === cache || path.startsWith(`${cache}/`))) {
        return false;
      }
      // The directories above a cache path exist only because of it.
      return !BUN_CACHE_PATHS.some((cache) => cache.startsWith(`${path}/`));
    })
    .sort();
}

/**
 * The body of each string literal in `source` with its 1-based starting line, comments skipped.
 * A small scanner, not the TypeScript tokenizer: it knows quotes, template interpolations and
 * `//` and `/* *\/` comments, but not regular expression literals, so a `/` that starts a regex
 * is read as division and a quote inside one would open a bogus literal. `src/` has no such
 * regex today, and the guard test reading it would fail loudly rather than pass silently.
 */
function stringLiterals(source: string): { line: number; body: string }[] {
  const literals: { line: number; body: string }[] = [];
  let line = 1;
  let index = 0;
  while (index < source.length) {
    const character = source[index] as string;
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      line += source.slice(index, stop).split("\n").length - 1;
      index = stop;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const start = line;
      let body = "";
      index += 1;
      while (index < source.length && source[index] !== character) {
        const inner = source[index] as string;
        if (inner === "\\") {
          body += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (character === "`" && inner === "$" && source[index + 1] === "{") {
          // An interpolation is one placeholder; its own strings and braces are not literals here.
          let depth = 0;
          index += 1;
          do {
            if (source[index] === "{") depth += 1;
            if (source[index] === "}") depth -= 1;
            if (source[index] === "\n") line += 1;
            index += 1;
          } while (depth > 0 && index < source.length);
          body += "$";
          continue;
        }
        if (inner === "\n") line += 1;
        body += inner;
        index += 1;
      }
      literals.push({ line: start, body });
    } else if (character === "\n") {
      line += 1;
    }
    index += 1;
  }
  return literals;
}

/**
 * Lines (1-based) holding a string literal that is a hand-written usage: `usage: tempad ...` in
 * any case, or a synopsis, `tempad <command>` anywhere in a line of the literal (after spaces,
 * words or an interpolation) followed by an option or placeholder (`[`, `<`). Comments are
 * skipped, and strings that merely name a command (`"tempad sync --forget"`, `"tempad setup: ..."`)
 * have neither. Only the commands of `COMMAND_TREE` are recognised: a synopsis for a command
 * that is not in the table is not caught, but such a command cannot run either.
 */
function handWrittenUsageLines(source: string): number[] {
  const commands = Object.keys(COMMAND_TREE).join("|");
  const synopsis = new RegExp(`(?:^|[^\\w/:.-])tempad (?:${commands})(?![\\w:-])[^\\n]*[[<]`);
  const lines = new Set<number>();
  for (const { line, body } of stringLiterals(source)) {
    body.split("\n").forEach((text, offset) => {
      if (/usage: tempad /i.test(text) || synopsis.test(text)) lines.add(line + offset);
    });
  }
  return [...lines];
}

describe("cli --help on every command and subcommand", () => {
  const paths: string[][] = [];
  for (const [command, nested] of Object.entries(COMMAND_TREE)) {
    paths.push([command]);
    for (const path of nested) paths.push([command, ...path.split(" ")]);
  }

  test("COMMAND_TREE and the usage texts document exactly the same paths", () => {
    const { table, usage } = documentedPaths();
    expect(usage.filter((path) => !table.includes(path))).toEqual([]);
    expect(
      table.filter(
        (path) => !usage.includes(path) && !table.some((other) => other.startsWith(`${path} `)),
      ),
    ).toEqual([]);
  });

  test("no usage text exists outside src/usage.ts", async () => {
    const offenders: string[] = [];
    for await (const file of new Glob("**/*.ts").scan(join(import.meta.dir, "..", "src"))) {
      if (file === "usage.ts") continue;
      const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
      for (const line of handWrittenUsageLines(source)) offenders.push(`${file}:${line}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the usage guard catches a planted literal and ignores strings that only name a command", () => {
    const fixtures = join(import.meta.dir, "fixtures", "usage-literals");
    expect(handWrittenUsageLines(readFileSync(join(fixtures, "hand-written.txt"), "utf8"))).toEqual(
      [2, 3, 4, 5, 6, 7, 8, 10],
    );
    expect(handWrittenUsageLines(readFileSync(join(fixtures, "clean.txt"), "utf8"))).toEqual([]);
    // The old prefix is still caught.
    expect(handWrittenUsageLines('const text = "usage: tempad rebuild";')).toEqual([1]);
  });

  test("POSITIONAL_LIMITS has an entry for every leaf of COMMAND_TREE and for nothing else", () => {
    const { table } = documentedPaths();
    const leaves = table.filter((path) => !table.some((other) => other.startsWith(`${path} `)));
    const expected = [...new Set([...leaves, "sync"])].sort();
    expect(Object.keys(POSITIONAL_LIMITS).sort()).toEqual(expected);
  });

  test("an extra positional on any path is a usage error: that path's usage on stderr, exit 2", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const failures: string[] = [];
      const paths = Object.keys(POSITIONAL_LIMITS);
      for (let start = 0; start < paths.length; start += 8) {
        await Promise.all(
          paths.slice(start, start + 8).map(async (joined) => {
            const path = joined.split(" ");
            const filler = Array.from({ length: POSITIONAL_LIMITS[joined] ?? 0 }, () => "x");
            // `sync`'s one positional is a source: past a flag the walk leaves it to the limit.
            const argv =
              joined === "sync"
                ? ["sync", "--full", "monday", "extra"]
                : [...path, ...filler, "extra"];
            const result = await runCli(sandbox, argv);
            const usage = usageForPath(path)[1]?.trim() ?? "missing";
            if (
              result.exitCode !== 2 ||
              result.stdout !== "" ||
              !result.stderr.includes('unexpected argument "extra"') ||
              !result.stderr.includes(usage) ||
              result.stderr.includes("tempad --help | -h")
            ) {
              failures.push(`${joined}: exit ${result.exitCode}, stderr ${result.stderr}`);
            }
          }),
        );
      }
      expect(failures).toEqual([]);
    } finally {
      cleanup(sandbox);
    }
  });

  test("each hand-back form uses only flags its command's usage entry documents, and has no pipe outside <...>", () => {
    for (const [form, path] of [
      [ANSWER_BELONGS_FORM, "answer"],
      [ANSWER_EXISTING_QUEST_FORM, "answer"],
      [ANSWER_NEW_QUEST_FORM, "answer"],
      [DECLARE_EXISTING_QUEST_FORM, "quest declare"],
      [DECLARE_NEW_QUEST_FORM, "quest declare"],
    ] as const) {
      const documented = usageText(path);
      expect(form.startsWith(`tempad ${path} `)).toBe(true);
      for (const flag of form.match(/--[\w-]+/g) ?? []) {
        expect(documented, `${flag} in ${form}`).toMatch(new RegExp(`${flag}(?![\\w-])`));
      }
      // A `|` outside `<...>` and quotes would be a shell pipe when the line is copied.
      expect(form.replace(/"[^"]*"/g, "").replace(/<[^>]*>/g, ""), form).not.toContain("|");
    }
  });

  test("the answer usage lists each form on its own line, --origin only with a new quest", () => {
    const lines = usageText("answer")
      .split("\n")
      .map((line) => line.trim());
    expect(lines).toHaveLength(3);
    // The error block: `usage:` alone, then every form indented the same.
    expect(usageBlock("answer").split("\n")).toEqual([
      "usage:",
      ...usageText("answer")
        .split("\n")
        .map((line) => `  ${line.trim()}`),
    ]);
    expect(lines.filter((line) => line.includes("--origin"))).toEqual([
      expect.stringContaining('--quest new:"<title>"'),
    ]);
  });

  test("one maximal valid invocation per path is accepted", () => {
    const valid: Record<string, string[]> = {
      "hero init": ["hero", "init", "Ada Lovelace"],
      "party add": ["party", "add", "acme", "Acme Inc", "--joined", "2026-01-02"],
      "party leave": ["party", "leave", "acme", "--reason", "contract ended"],
      "party list": ["party", "list"],
      "client add": ["client", "add", "acme", "Acme Inc"],
      "saga add": ["saga", "add", "--owner", "hero", "Ship it", "--statement", "all of it"],
      "saga reword": ["saga", "reword", "S1", "New title", "--statement", "text"],
      "saga replace": ["saga", "replace", "S1", "New title", "--statement", "t", "--reason", "r"],
      "saga end": ["saga", "end", "S1", "--reason", "achieved"],
      "saga edit": ["saga", "edit", "S1", "New title"],
      "saga list": ["saga", "list", "--all", "--as-of", "2026-01-02T00:00:00Z"],
      "quest add": [
        "quest",
        "add",
        "--owner",
        "party:acme",
        "--serves",
        "S1",
        "Title",
        "--outcome",
        "o",
        "--done",
        "d",
        "--due",
        "2026-02-01",
        "--budget",
        "2h",
        "--commitment",
        "promised",
      ],
      "quest reword": ["quest", "reword", "Q1", "Title", "--outcome", "o"],
      "quest replace": ["quest", "replace", "Q1", "Title", "--outcome", "o", "--reason", "r"],
      "quest end": ["quest", "end", "Q1", "--reason", "r"],
      "quest edit": ["quest", "edit", "Q1", "Title"],
      "quest confirm": ["quest", "confirm", "Q1"],
      "quest merge": ["quest", "merge", "Q1", "--into", "Q2"],
      "quest pause": ["quest", "pause", "Q1", "--reason", "r"],
      "quest resume": ["quest", "resume", "Q1"],
      "quest done": ["quest", "done", "Q1", "--reason=r"],
      "quest abandon": ["quest", "abandon", "Q1", "--reason", "r"],
      "quest branch": [
        "quest",
        "branch",
        "Q1",
        "--deviates-from",
        "Q2",
        "--trigger",
        "t",
        "--kind",
        "waiting",
        "--at",
        "2026-01-02T00:00:00Z",
      ],
      "quest return": ["quest", "return", "Q1", "--to", "Q2"],
      "quest retract": ["quest", "retract", "Q1", "--reason", "r", "--force"],
      "quest delete": ["quest", "delete", "Q1", "--reason", "r", "--force"],
      "quest declare": [
        "quest",
        "declare",
        "--session",
        "s1",
        "--parent",
        "p1",
        "--new",
        "Title",
        "--outcome",
        "o",
        "--commitment",
        "promised",
        "--project",
        "p",
        "--serves",
        "S1",
        "--plan",
        "a; b",
        "--by",
        "agent",
        "--at",
        "2026-01-02T00:00:00Z",
      ],
      "quest list": [
        "quest",
        "list",
        "--all",
        "--unconfirmed",
        "--side",
        "--as-of",
        "2026-01-02T00:00:00Z",
      ],
      "stint list": ["stint", "list", "--open", "--quest", "Q1"],
      "trace list": ["trace", "list", "--since", "2026-01-02T00:00:00Z", "--stint", "T1"],
      "agent spawned": [
        "agent",
        "spawned",
        "--parent",
        "lead1",
        "--child",
        "kid1",
        "--role",
        "developer",
        "--harness",
        "claude",
        "--model",
        "m",
        "--effort",
        "high",
        "--ref",
        "tempad-l1a",
        "--quest",
        "Q1",
        "--title",
        "Agent spawned event",
      ],
      "impact set": ["impact", "set", "pr:acme/x#1", "Fixed it", "--theme", "fix"],
      "impact list": [
        "impact",
        "list",
        "--project",
        "p",
        "--from",
        "2026-01-01",
        "--to",
        "2026-02-01",
      ],
      "impact import": ["impact", "import", "impacts.json"],
      answer: [
        "answer",
        "Q9",
        "--quest",
        "new:Title",
        "--why",
        "w",
        "--origin",
        "current",
        "--trigger",
        "t",
        "--kind",
        "blocker",
      ],
      rebuild: ["rebuild", "--until", "2026-01-02T00:00:00Z"],
      setup: [
        "setup",
        "--non-interactive",
        "--home",
        "/tmp/x",
        "--force",
        "--no-verify",
        "--monday-api-token",
        "t",
        "--tz=UTC",
      ],
      init: ["init", "--home", "/tmp/x"],
      sync: ["sync", "monday", "--full"],
      "sync monday": ["sync", "monday", "--full"],
      "sync github": ["sync", "github", "--full"],
      "sync claude": ["sync", "claude", "--full"],
      "report daily": [
        "report",
        "daily",
        "--from",
        "2026-01-01",
        "--to",
        "2026-01-31",
        "--org",
        "o",
        "--project",
        "p",
        "--out",
        "out.md",
        "--as-of",
        "2026-02-01T00:00:00Z",
        "--party",
        "acme",
        "--client",
        "acme",
        "--pr-date",
        "authored",
      ],
      "report project": ["report", "project", "--from", "2026-01-01", "--to", "2026-01-31"],
      "report hourly": ["report", "hourly", "--from", "2026-01-01", "--to", "2026-01-31"],
      "report weekly": ["report", "weekly", "--from", "2026-01-01", "--to", "2026-01-31"],
      "w5 enqueue": ["w5", "enqueue", "--session", "s1", "--forced"],
      "w5 context": ["w5", "context", "--session", "s1"],
      "w5 run": ["w5", "run", "--detached"],
      "w5 hook install": ["w5", "hook", "install", "--scope", "project"],
      "w5 hook uninstall": ["w5", "hook", "uninstall", "--scope=user"],
      "w5 backfill": ["w5", "backfill", "--from", "2026-01-01", "--model", "m", "--force"],
      "w5 dedupe": ["w5", "dedupe", "--dry-run"],
      "w5 eval": [
        "w5",
        "eval",
        "--from",
        "2026-01-01",
        "--to",
        "2026-01-31",
        "--db",
        "x.db",
        "--declare",
        "d.toml",
      ],
      quiet: ["quiet", "2h"],
      review: ["review", "--days", "3"],
      scry: ["scry", "--json", "--days", "3", "--fast"],
      "schedule install": ["schedule", "install"],
      "schedule remove": ["schedule", "remove"],
      "schedule status": ["schedule", "status", "--json"],
      "skill install": ["skill", "install", "--scope", "project"],
      "project register": [
        "project",
        "register",
        "~/work/x",
        "--name",
        "X",
        "--org",
        "o",
        "--project",
        "p",
      ],
      "project list": ["project", "list"],
      "project reresolve": ["project", "reresolve", "~/work/x"],
    };
    expect(Object.keys(valid).sort()).toEqual(Object.keys(POSITIONAL_LIMITS).sort());
    for (const [joined, argv] of Object.entries(valid)) {
      const [command = "", ...rest] = argv;
      const walked = walkPath(command, rest);
      if (!walked.ok) throw new Error(`${joined}: ${walked.message}`);
      expect(walked.path.join(" "), joined).toBe(joined === "sync" ? "sync monday" : joined);
      expect(checkPositionals(walked.path, rest), joined).toBeNull();
    }
    // The bare source form, where the walk stops at the flag and the limit takes over.
    const sourceAfterFlag = walkPath("sync", ["--full", "monday"]);
    expect(
      sourceAfterFlag.ok && checkPositionals(sourceAfterFlag.path, ["--full", "monday"]),
    ).toBeNull();
  });

  test("every boolean option parseArgs declares in src/ is in BOOLEAN_FLAGS, and no string option shares its name", async () => {
    const booleans = new Set<string>();
    const strings = new Set<string>();
    for await (const file of new Glob("**/*.ts").scan(join(import.meta.dir, "..", "src"))) {
      const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
      for (const match of source.matchAll(/"?([a-z][\w-]*)"?: \{ type: "(boolean|string)"/g)) {
        (match[2] === "boolean" ? booleans : strings).add(`--${match[1]}`);
      }
    }
    expect(booleans.size).toBeGreaterThan(10);
    expect([...booleans].filter((flag) => !BOOLEAN_FLAGS.has(flag))).toEqual([]);
    expect([...strings].filter((flag) => BOOLEAN_FLAGS.has(flag))).toEqual([]);
  });

  test("flags and their values are not positionals", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      for (const args of [
        ["scry", "--days", "3", "--json"],
        ["review", "--days=2"],
      ]) {
        const result = await runCli(sandbox, args);
        expect(result.stderr).not.toContain("unexpected argument");
      }
      const terminated = await runCli(sandbox, ["rebuild", "--", "extra"]);
      expect(terminated.exitCode).toBe(2);
      expect(terminated.stderr).toContain('unexpected argument "extra"');
    } finally {
      cleanup(sandbox);
    }
  });

  test("each path's help carries the options its command requires", async () => {
    const sandbox = makeSandbox();
    try {
      for (const [path, expected] of [
        [["quest", "merge"], "--into <id>"],
        [["quest", "return"], "--to <quest-id>"],
        [["quest", "branch"], "--deviates-from"],
        [["quest", "pause"], "[--reason]"],
        [["saga", "end"], "achieved|abandoned"],
        [["saga", "reword"], "[--statement]"],
        [["answer"], "--origin current"],
        [["quest", "declare"], "--commitment promised|personal|exploratory"],
      ] as const) {
        const result = await runCli(sandbox, ["help", ...path]);
        expect(result.stdout).toContain(expected);
        expect(result.stdout).not.toContain("...  ");
      }
      // A usage error from the command prints the same text as its help.
      configure(sandbox);
      const error = await runCli(sandbox, ["quest", "merge"]);
      const help = await runCli(sandbox, ["help", "quest", "merge"]);
      expect(error.stderr).toContain(help.stdout.split("\n")[1]?.trim() ?? "missing");
    } finally {
      cleanup(sandbox);
    }
  });

  test("`sync --full bogus` names the unknown source and `help w5 --help` is `help w5`", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const sync = await runCli(sandbox, ["sync", "--full", "bogus"]);
      expect(sync.exitCode).toBe(2);
      expect(sync.stderr).toContain('unknown source "bogus"');
      const viaFlag = await runCli(sandbox, ["help", "w5", "--help"]);
      const plain = await runCli(sandbox, ["help", "w5"]);
      expect(viaFlag.exitCode).toBe(0);
      expect(viaFlag.stdout).toBe(plain.stdout);
    } finally {
      cleanup(sandbox);
    }
  });

  test("a command dropped from the table is unreachable, not run", async () => {
    // Every nested path of the table parses as a path; one the table lacks is a usage error.
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const result = await runCli(sandbox, ["w5", "not-in-the-table"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('unknown subcommand "not-in-the-table" for tempad w5');
    } finally {
      cleanup(sandbox);
    }
  });

  test("the table covers every command the top-level usage lists", async () => {
    const sandbox = makeSandbox();
    try {
      const { stdout } = await runCli(sandbox, ["--help"]);
      const listed = new Set<string>();
      for (const line of stdout.split("\n")) {
        const match = /^ {2}tempad ([a-z0-9]+)/.exec(line);
        if (match?.[1]) listed.add(match[1]);
      }
      listed.delete("init");
      for (const command of listed) expect(Object.keys(COMMAND_TREE)).toContain(command);
      for (const command of Object.keys(COMMAND_TREE)) {
        if (command !== "init") expect(listed).toContain(command);
      }
    } finally {
      cleanup(sandbox);
    }
  });

  for (const configured of [false, true]) {
    test(`--help and -h print usage to stdout, exit 0, no stack trace, no side effects (${configured ? "configured" : "unconfigured"} home)`, async () => {
      const sandbox = makeSandbox();
      try {
        if (configured) configure(sandbox);
        const before = configured ? readdirSync(sandbox.tempadHome).sort() : null;
        const homeBefore = listTree(sandbox.home);
        for (const flag of ["--help", "-h"]) {
          const results: { path: string[]; result: CliResult }[] = [];
          for (let index = 0; index < paths.length; index += 8) {
            results.push(
              ...(await Promise.all(
                paths
                  .slice(index, index + 8)
                  .map(async (path) => ({ path, result: await runCli(sandbox, [...path, flag]) })),
              )),
            );
          }
          for (const { path, result } of results) {
            const label = `tempad ${path.join(" ")} ${flag}`;
            expect({ label, exitCode: result.exitCode }).toEqual({ label, exitCode: 0 });
            expect({ label, stderr: result.stderr }).toEqual({ label, stderr: "" });
            expect(result.stdout).toContain("Usage:");
            expect(`${result.stdout}${result.stderr}`).not.toMatch(
              /TypeError|ERR_PARSE_ARGS|\n\s+at /,
            );
          }
        }
        if (before === null) expect(existsSync(sandbox.tempadHome)).toBe(false);
        else expect(readdirSync(sandbox.tempadHome).sort()).toEqual(before);
        expect(readdirSync(sandbox.cwd)).toEqual([]);
        expect(listTree(sandbox.home)).toEqual(homeBefore);
      } finally {
        cleanup(sandbox);
      }
    }, 120_000);
  }

  test("`help <path>` and `<path> --help` print the same specific usage for every path", async () => {
    const sandbox = makeSandbox();
    try {
      const full = (await runCli(sandbox, ["--help"])).stdout;
      expect(full).toContain("Run tempad help <command> for one command.");
      expect((await runCli(sandbox, ["help"])).stdout).toBe(full);
      const fullLines = full.split("\n").filter((line) => line.startsWith("  tempad "));
      for (let index = 0; index < paths.length; index += 8) {
        await Promise.all(
          paths.slice(index, index + 8).map(async (path) => {
            const label = path.join(" ");
            const viaHelp = await runCli(sandbox, ["help", ...path]);
            const viaFlag = await runCli(sandbox, [...path, "--help"]);
            expect({ label, exitCode: viaHelp.exitCode, stderr: viaHelp.stderr }).toEqual({
              label,
              exitCode: 0,
              stderr: "",
            });
            expect({ label, same: viaFlag.stdout }).toEqual({ label, same: viaHelp.stdout });
            const lines = viaHelp.stdout.split("\n").filter((line) => line.startsWith("  tempad "));
            expect({ label, lines: lines.length > 0 }).toEqual({ label, lines: true });
            // `init` is the hidden alias of `setup`, so its usage names `setup`.
            const names = path.map((part) =>
              part === "init" && path.length === 1 ? "setup" : part,
            );
            for (const part of names)
              expect({ label, text: viaHelp.stdout }).toEqual({
                label,
                text: expect.stringContaining(part),
              });
            // Specific: never the whole list, unless the command is the whole list.
            if (fullLines.length > lines.length) expect(viaHelp.stdout).not.toBe(full);
            expect(lines.length).toBeLessThan(fullLines.length);
          }),
        );
      }
      // A nested path lists fewer lines than its command.
      const quest = (await runCli(sandbox, ["help", "quest"])).stdout;
      const merge = (await runCli(sandbox, ["help", "quest", "merge"])).stdout;
      expect(quest.split("\n").length).toBeGreaterThan(merge.split("\n").length);
      expect(merge).not.toContain("tempad quest declare");
      const backfill = (await runCli(sandbox, ["w5", "backfill", "-h"])).stdout;
      expect(backfill).toContain("tempad w5 backfill [--days <n> | --from <iso>]");
      expect(backfill).not.toContain("tempad w5 dedupe");
    } finally {
      cleanup(sandbox);
    }
  }, 120_000);

  test("`help <unknown>` names the unknown part, prints the nearest usage to stderr, exits 2", async () => {
    const sandbox = makeSandbox();
    try {
      const command = await runCli(sandbox, ["help", "bogus"]);
      expect(command.exitCode).toBe(2);
      expect(command.stdout).toBe("");
      expect(command.stderr).toContain('unknown command "bogus"');
      expect(command.stderr).toContain("tempad quest add");

      const nested = await runCli(sandbox, ["help", "w5", "bogus"]);
      expect(nested.exitCode).toBe(2);
      expect(nested.stdout).toBe("");
      expect(nested.stderr).toContain('unknown subcommand "bogus" for tempad w5');
      expect(nested.stderr).toContain("tempad w5 backfill");
      expect(nested.stderr).not.toContain("tempad quest add");

      const extra = await runCli(sandbox, ["help", "w5", "backfill", "nope"]);
      expect(extra.exitCode).toBe(2);
      expect(extra.stderr).toContain('unknown subcommand "nope" for tempad w5 backfill');
    } finally {
      cleanup(sandbox);
    }
  });

  test("--help after other arguments still prints usage instead of running the command", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      const homeBefore = listTree(sandbox.home);
      for (const args of [
        ["w5", "backfill", "--days", "3", "--help"],
        ["w5", "run", "--detached", "--help"],
        ["sync", "monday", "--full", "-h"],
        ["w5", "hook", "install", "--scope", "project", "--help"],
      ]) {
        const result = await runCli(sandbox, args);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Usage:");
        expect(result.stderr).toBe("");
      }
      expect(existsSync(join(sandbox.cwd, ".claude"))).toBe(false);
      expect(existsSync(join(sandbox.tempadHome, "tempad.db"))).toBe(false);
      expect(listTree(sandbox.home)).toEqual(homeBefore);
    } finally {
      cleanup(sandbox);
    }
  });

  test("an unknown nested name with --help is still a usage error", async () => {
    const sandbox = makeSandbox();
    try {
      configure(sandbox);
      for (const args of [
        ["w5", "bogus", "--help"],
        ["quest", "bogus", "-h"],
        ["w5", "hook", "bogus", "--help"],
        ["sync", "bogus", "--help"],
      ]) {
        const result = await runCli(sandbox, args);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("unknown subcommand");
        expect(result.stderr).not.toContain("Unknown option");
      }
    } finally {
      cleanup(sandbox);
    }

    const sandbox2 = makeSandbox();
    try {
      configure(sandbox2);
      // After `--` nothing is a flag: no help, and the command is not run as help either.
      const result = await runCli(sandbox2, ["w5", "backfill", "--", "--help"]);
      expect(result.stdout).not.toContain("Usage:");
    } finally {
      cleanup(sandbox2);
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
        `tempad sync monday needs MONDAY_API_TOKEN, MONDAY_USER; set them in ${join(sandbox.tempadHome, ".env")} or run /tempad:setup in Claude Code, or \`tempad setup\` in a terminal\n`,
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
        `tempad report daily needs TZ; set it in ${join(sandbox.tempadHome, ".env")} or run /tempad:setup in Claude Code, or \`tempad setup\` in a terminal\n`,
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
      // Written by hand, not by `w5 hook install`: install refuses to run from a checkout that
      // lives under the OS temp directory, and this test is about uninstall.
      const foreign = { type: "command", command: "echo someone-elses-hook" };
      const fragment = renderHookSettings("/opt/tempad/src/cli.ts");
      writeFileSync(
        settingsPath,
        JSON.stringify({
          theme: "dark",
          hooks: { ...fragment, Stop: [{ hooks: [foreign] }, ...(fragment.Stop ?? [])] },
        }),
      );
      expect(readFileSync(settingsPath, "utf8")).toMatch(/"tempad":\s*true/);
      const uninstall = await runCli(sandbox, ["w5", "hook", "uninstall"]);
      expect(uninstall.exitCode).toBe(0);
      const after = readFileSync(settingsPath, "utf8");
      expect(after).not.toMatch(/"tempad":\s*true/);
      expect(JSON.parse(after)).toEqual({
        theme: "dark",
        hooks: {
          Stop: [{ hooks: [foreign] }],
          PreCompact: [],
          SessionEnd: [],
          UserPromptSubmit: [],
        },
      });
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
    try {
      const exitCode = withEnvironment({ HOME: tempHome, CLAUDE_CONFIG_DIR: null }, () =>
        runSkillCommand(["install", "--scope", "user"]),
      );
      expect(exitCode).toBe(0);
      const destination = join(tempHome, ".claude", "skills", "tempad-quest", "SKILL.md");
      expect(existsSync(destination)).toBe(true);
      const content = readFileSync(destination, "utf8");
      expect(content).toContain("name: tempad-quest");
      expect(content).not.toMatch(/^name: quest$/m);
      expect(content).toContain("tempad quest declare");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("--scope user follows CLAUDE_CONFIG_DIR when set and non-empty, else HOME", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "tempad-skill-home-"));
    const configDir = mkdtempSync(join(tmpdir(), "tempad-skill-config-"));
    try {
      withEnvironment({ HOME: tempHome, CLAUDE_CONFIG_DIR: configDir }, () => {
        expect(runSkillCommand(["install", "--scope", "user"])).toBe(0);
      });
      expect(existsSync(join(configDir, "skills", "tempad-quest", "SKILL.md"))).toBe(true);
      expect(existsSync(join(tempHome, ".claude"))).toBe(false);

      withEnvironment({ HOME: tempHome, CLAUDE_CONFIG_DIR: "" }, () => {
        expect(runSkillCommand(["install", "--scope", "user"])).toBe(0);
      });
      expect(existsSync(join(tempHome, ".claude", "skills", "tempad-quest", "SKILL.md"))).toBe(
        true,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("--scope project copies the skill into .claude/skills under the current working directory", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "tempad-skill-home-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tempad-skill-project-"));
    const previousCwd = process.cwd();
    process.chdir(projectDir);
    try {
      const exitCode = withEnvironment({ HOME: tempHome, CLAUDE_CONFIG_DIR: null }, () =>
        runSkillCommand(["install", "--scope", "project"]),
      );
      expect(exitCode).toBe(0);
      const destination = join(projectDir, ".claude", "skills", "tempad-quest", "SKILL.md");
      expect(existsSync(destination)).toBe(true);
      expect(existsSync(join(tempHome, ".claude"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("--scope user throws a clear error when HOME is unset, never defaults to '/'", () => {
    withEnvironment({ HOME: null, CLAUDE_CONFIG_DIR: null }, () => {
      expect(() => runSkillCommand(["install", "--scope", "user"])).toThrow(/HOME is not set/);
    });
  });
});
