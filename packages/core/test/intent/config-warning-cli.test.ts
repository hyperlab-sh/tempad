import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function run(toml: string, args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "tempad-config-warning-"));
  const cwd = mkdtempSync(join(tmpdir(), "tempad-config-warning-cwd-"));
  directories.push(home, cwd);
  writeFileSync(join(home, ".env"), "TZ=UTC\n");
  writeFileSync(join(home, "tempad.toml"), toml);
  const env: Record<string, string | undefined> = { ...process.env, TEMPAD_HOME: home };
  delete env.HOST_SLUG;
  delete env.TEMPAD_SYNC_TOKEN;
  const proc = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", CLI, ...args],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr, toml: join(home, "tempad.toml") };
}

describe("a [w5] key of the wrong type, through the CLI", () => {
  test("warns once on stderr per key and the command still runs on the default", async () => {
    const result = await run('[w5]\nstint_idle_minutes = "abc"\nwatch_turns = "x"\n', [
      "saga",
      "list",
    ]);
    expect(result.code).toBe(0);
    const lines = result.stderr.split("\n").filter((line) => line !== "");
    expect(lines).toEqual([
      `${result.toml}: [w5].watch_turns must be a whole number, 0 or more, got "x" (a string); using the default 3. Fix the value.`,
      `${result.toml}: [w5].stint_idle_minutes must be a number, 0 or more, got "abc" (a string); using the default 45. Fix the value.`,
    ]);
    expect(result.stdout).not.toContain("tempad.toml");
  });

  test("a correct config prints nothing on stderr", async () => {
    const result = await run("[w5]\nstint_idle_minutes = 30\n", ["saga", "list"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });
});
