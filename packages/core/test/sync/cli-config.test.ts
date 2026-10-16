import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { temporaryDirectory } from "./helpers";

// review-3 L1: a malformed [sync] must not break commands that never sync,
// and must fail the ones that do with one clean line, not a stack trace.

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

let root: string;
let home: string;

beforeEach(() => {
  root = temporaryDirectory("tempad-sync-cli-");
  home = join(root, "tempad");
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "cwd"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, ".env"),
    ["CLAUDE_DIRS=/nowhere", "HOST_SLUG=test-host", "TZ=UTC", "SINCE=2020-01-01"].join("\n"),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", CLI, ...args],
    cwd: join(root, "cwd"),
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: join(root, "home"),
      TEMPAD_HOME: home,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

// The last field: whether the rest of tempad.toml still parses. A TOML
// syntax error also breaks the [w5]/intent config the database commands
// read (loadIntentConfig), which is not sync's to change; only the
// config-free hook command must survive that one.
const MALFORMED: [string, string, string, boolean][] = [
  [
    "a non-boolean enabled",
    '[sync]\nenabled = "yes"\n',
    "[sync].enabled must be true or false",
    true,
  ],
  ["a non-table [sync]", "sync = 3\n", "[sync] must be a table", true],
  ["a TOML syntax error", "[sync\nurl = 1\n", "tempad.toml is not valid TOML", false],
];

function expectOneCleanLine(stderr: string, fragment: string): void {
  const lines = stderr.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]?.startsWith("sync: ")).toBe(true);
  expect(lines[0]).toContain(fragment);
}

describe("a malformed [sync] section", () => {
  for (const [label, toml, fragment, parses] of MALFORMED) {
    describe(label, () => {
      beforeEach(() => {
        writeFileSync(join(home, "tempad.toml"), toml);
      });

      test("commands that never sync still work", async () => {
        expect((await cli(["w5", "hook", "uninstall"])).code).toBe(0);
        if (!parses) return;
        expect((await cli(["w5", "context", "--session", "s-1"])).code).toBe(0);
        expect((await cli(["w5", "enqueue", "--session", "s-1"])).code).toBe(0);
        const quiet = await cli(["quiet", "2h"]);
        expect(quiet.stderr).not.toContain("[sync]");
        expect(quiet.code).toBe(0);
      });

      test("tempad sync exits 1 with one sync: line", async () => {
        for (const args of [["sync", "--push"], ["sync"]]) {
          const result = await cli(args);
          expect(result.code).toBe(1);
          expectOneCleanLine(result.stderr, fragment);
        }
      });

      test("w5 backfill, which reads [sync], exits 1 with one sync: line", async () => {
        const result = await cli(["w5", "backfill"]);
        expect(result.code).toBe(1);
        expectOneCleanLine(result.stderr, fragment);
      });
    });
  }
});
