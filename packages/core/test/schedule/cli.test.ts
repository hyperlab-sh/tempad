import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function tempad(args: string[], home: string) {
  const proc = Bun.spawn({
    cmd: ["bun", CLI, ...args],
    cwd: home,
    env: { ...process.env, HOME: home, TEMPAD_HOME: join(home, ".tempad") },
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

// Only paths that never reach launchctl/systemctl: usage errors, which exit before any platform check.
describe("tempad schedule (process)", () => {
  test("an unknown action or a stray flag exits 2 with the usage and writes nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "tempad-schedule-cli-"));
    try {
      for (const args of [["schedule"], ["schedule", "bogus"], ["schedule", "install", "--json"]]) {
        const result = await tempad(args, home);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("usage: tempad schedule install");
      }
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the command is in --help", async () => {
    const home = mkdtempSync(join(tmpdir(), "tempad-schedule-cli-"));
    try {
      const result = await tempad(["--help"], home);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("tempad schedule status [--json]");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
