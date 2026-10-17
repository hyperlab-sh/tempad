import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSyncLock, SYNC_BUSY_MESSAGE } from "../../src/sync/lock";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function configuredHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tempad-synclock-"));
  directories.push(home);
  writeFileSync(join(home, ".env"), "");
  return home;
}

/** A pid that is certainly gone: a child that already exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

describe("acquireSyncLock", () => {
  test("takes sync.lock with this pid and removes it on dispose", () => {
    const home = configuredHome();
    {
      using lock = acquireSyncLock(home);
      expect(lock.held).toBe(true);
      expect(readFileSync(join(home, "sync.lock"), "utf8")).toBe(String(process.pid));
    }
    expect(existsSync(join(home, "sync.lock"))).toBe(false);
  });

  test("a second sync while the first holds it is not held, and does not release the first's lock", () => {
    const home = configuredHome();
    using first = acquireSyncLock(home);
    {
      using second = acquireSyncLock(home);
      expect(second.held).toBe(false);
    }
    expect(first.held).toBe(true);
    expect(existsSync(join(home, "sync.lock"))).toBe(true);
  });

  test("a lock left by a crashed run is cleared once it is 30 minutes old and its pid is gone", async () => {
    const home = configuredHome();
    const lockPath = join(home, "sync.lock");
    writeFileSync(lockPath, String(await deadPid()));
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(lockPath, old, old);
    const lines: string[] = [];
    using lock = acquireSyncLock(home, (line) => lines.push(line));
    expect(lock.held).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("sync.lock is stale");
    expect(lines[0]).not.toContain("w5.lock");
  });

  test("a fresh lock of a dead pid still blocks (the age rule keeps a sleeping laptop's run safe)", async () => {
    const home = configuredHome();
    writeFileSync(join(home, "sync.lock"), String(await deadPid()));
    using lock = acquireSyncLock(home);
    expect(lock.held).toBe(false);
  });

  test("an old lock whose pid is alive is kept", () => {
    const home = configuredHome();
    const lockPath = join(home, "sync.lock");
    writeFileSync(lockPath, String(process.pid));
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(lockPath, old, old);
    using lock = acquireSyncLock(home);
    expect(lock.held).toBe(false);
  });

  test("an unconfigured or missing home creates nothing and reports held", () => {
    const empty = mkdtempSync(join(tmpdir(), "tempad-synclock-empty-"));
    directories.push(empty);
    {
      using lock = acquireSyncLock(empty);
      expect(lock.held).toBe(true);
    }
    expect(existsSync(join(empty, "sync.lock"))).toBe(false);
    using missing = acquireSyncLock(join(empty, "nope"));
    expect(missing.held).toBe(true);
  });
});

describe("tempad sync while another sync runs", () => {
  async function tempad(args: string[], home: string) {
    const cwd = mkdtempSync(join(tmpdir(), "tempad-synclock-cwd-"));
    directories.push(cwd);
    const proc = Bun.spawn({
      cmd: ["bun", CLI, ...args],
      cwd,
      env: { ...process.env, TEMPAD_HOME: home },
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

  test("skips with exit 0 and a message, collecting nothing and leaving the lock alone", async () => {
    const home = configuredHome();
    writeFileSync(join(home, "sync.lock"), String(process.pid));
    const result = await tempad(["sync"], home);
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe(SYNC_BUSY_MESSAGE);
    expect(result.stdout).toBe("");
    expect(existsSync(join(home, "tempad.db"))).toBe(false);
    expect(readFileSync(join(home, "sync.lock"), "utf8")).toBe(String(process.pid));
  });

  test("--forget and --rejoin are local and ignore the lock", async () => {
    const home = configuredHome();
    writeFileSync(join(home, "sync.lock"), String(process.pid));
    const result = await tempad(["sync", "--forget"], home);
    expect(result.stderr).not.toContain("already running");
  });

  test("a lock-free run releases the lock when it ends, even when it fails", async () => {
    const home = configuredHome();
    // No MONDAY_* configuration: the run fails after taking the lock.
    const result = await tempad(["sync", "monday"], home);
    expect(result.code).toBe(1);
    expect(existsSync(join(home, "sync.lock"))).toBe(false);
  });
});
