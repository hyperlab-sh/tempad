import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "./helpers";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const GUARD = join(import.meta.dir, "libsql-guard.ts");

let home: string;

beforeEach(() => {
  home = temporaryDirectory("tempad-sync-offline-");
  const claudeDir = join(home, "claude");
  mkdirSync(join(claudeDir, "projects", "offline"), { recursive: true });
  writeFileSync(
    join(claudeDir, "projects", "offline", "session-1.jsonl"),
    `${JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: "sess-offline-1",
      timestamp: "2026-01-01T10:00:00.000Z",
      origin: { kind: "human" },
      message: { role: "user", content: "hello" },
    })}\n`,
  );
  writeFileSync(
    join(home, ".env"),
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
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function guardedSync(): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, TEMPAD_HOME: home };
  delete env.TEMPAD_SYNC_TOKEN;
  const proc = Bun.spawn({
    cmd: [process.execPath, "--preload", GUARD, CLI, "sync", "claude"],
    env,
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

describe("offline guarantee", () => {
  test("tempad sync without [sync] never resolves @libsql/client", async () => {
    const result = await guardedSync();
    expect(result.stderr).not.toContain("LIBSQL_GUARD");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("claude: inserted=1");
    expect(result.stdout).not.toContain("sync:");
  });

  test("the guard does trip once [sync] is enabled (the test above is not vacuous)", async () => {
    writeFileSync(join(home, "tempad.toml"), '[sync]\nurl = "http://127.0.0.1:9"\n');
    writeFileSync(
      join(home, ".env"),
      `${await Bun.file(join(home, ".env")).text()}\nTEMPAD_SYNC_TOKEN=t`,
    );
    const result = await guardedSync();
    expect(result.stdout).toContain("claude: inserted=1");
    expect(result.stderr).toContain("LIBSQL_GUARD");
    expect(result.code).toBe(1);
  });
});
