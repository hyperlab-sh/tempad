import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSyncLock,
  CLEARING_STALE_MS,
  SYNC_BUSY_MESSAGE,
  SYNC_CLEARING_FILE,
} from "../../src/sync/lock";

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

  test("a lock whose holder was killed is cleared at once, not after the 30 minute grace", async () => {
    const home = configuredHome();
    const pid = await deadPid();
    writeFileSync(join(home, "sync.lock"), String(pid));
    const lines: string[] = [];
    using lock = acquireSyncLock(home, (line) => lines.push(line));
    expect(lock.held).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("sync.lock is stale (");
    expect(lines[0]).toContain(`its runner is not running (pid ${pid})`);
    expect(readFileSync(join(home, "sync.lock"), "utf8")).toBe(String(process.pid));
  });

  test("a SIGKILLed sync leaves a lock the next sync clears", async () => {
    const home = configuredHome();
    const child = Bun.spawn(["sleep", "60"]);
    writeFileSync(join(home, "sync.lock"), String(child.pid));
    {
      using blocked = acquireSyncLock(home);
      expect(blocked.held).toBe(false);
    }
    child.kill("SIGKILL");
    await child.exited;
    using lock = acquireSyncLock(home);
    expect(lock.held).toBe(true);
  });

  test("a lock with no pid yet is not a dead holder: fresh it blocks, 30 minutes old the age rule clears it", () => {
    const home = configuredHome();
    const lockPath = join(home, "sync.lock");
    writeFileSync(lockPath, "");
    {
      using fresh = acquireSyncLock(home);
      expect(fresh.held).toBe(false);
    }
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(lockPath, old, old);
    const lines: string[] = [];
    using lock = acquireSyncLock(home, (line) => lines.push(line));
    expect(lock.held).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("sync.lock is stale");
    expect(lines[0]).not.toContain("w5.lock");
  });

  test("a fresh lock holding this process's own pid is held, not cleared", () => {
    const home = configuredHome();
    writeFileSync(join(home, "sync.lock"), String(process.pid));
    using lock = acquireSyncLock(home);
    expect(lock.held).toBe(false);
  });

  test("the own-pid guard holds even when liveness says dead: a lock with this pid is never cleared", () => {
    const home = configuredHome();
    writeFileSync(join(home, "sync.lock"), String(process.pid));
    using lock = acquireSyncLock(home, undefined, { isAlive: () => false });
    expect(lock.held).toBe(false);
    expect(readFileSync(join(home, "sync.lock"), "utf8")).toBe(String(process.pid));
  });

  test("a run that judged the lock dead does not remove a live lock another run took in between", async () => {
    const home = configuredHome();
    const lockPath = join(home, "sync.lock");
    writeFileSync(lockPath, String(await deadPid()));
    const sleeper = Bun.spawn(["sleep", "60"]);
    try {
      using lock = acquireSyncLock(home, undefined, {
        // Another run clears the dead lock and takes its own, after this run read the dead pid.
        afterJudgedDead: () => {
          rmSync(lockPath);
          writeFileSync(lockPath, String(sleeper.pid));
        },
      });
      expect(lock.held).toBe(false);
      expect(readFileSync(lockPath, "utf8")).toBe(String(sleeper.pid));
      expect(existsSync(join(home, SYNC_CLEARING_FILE))).toBe(false);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  test("a run that finds another run clearing skips and leaves the dead lock to it", async () => {
    const home = configuredHome();
    const deadLock = String(await deadPid());
    writeFileSync(join(home, "sync.lock"), deadLock);
    writeFileSync(join(home, SYNC_CLEARING_FILE), String(process.pid));
    using lock = acquireSyncLock(home);
    expect(lock.held).toBe(false);
    expect(readFileSync(join(home, "sync.lock"), "utf8")).toBe(deadLock);
    expect(readFileSync(join(home, SYNC_CLEARING_FILE), "utf8")).toBe(String(process.pid));
  });

  test("a clearing lock left by a clearer that died is removed, that run skips, the next one proceeds", async () => {
    const home = configuredHome();
    writeFileSync(join(home, "sync.lock"), String(await deadPid()));
    writeFileSync(join(home, SYNC_CLEARING_FILE), String(await deadPid()));
    {
      using first = acquireSyncLock(home);
      expect(first.held).toBe(false);
    }
    expect(existsSync(join(home, SYNC_CLEARING_FILE))).toBe(false);
    using second = acquireSyncLock(home);
    expect(second.held).toBe(true);
  });

  test("a pid-less clearing lock is left alone while fresh, then removed once older than the critical section", async () => {
    const home = configuredHome();
    const deadLock = String(await deadPid());
    writeFileSync(join(home, "sync.lock"), deadLock);
    const clearingPath = join(home, SYNC_CLEARING_FILE);
    writeFileSync(clearingPath, "");
    {
      using fresh = acquireSyncLock(home);
      expect(fresh.held).toBe(false);
    }
    expect(existsSync(clearingPath)).toBe(true);

    const old = new Date(Date.now() - CLEARING_STALE_MS - 1_000);
    utimesSync(clearingPath, old, old);
    {
      using stale = acquireSyncLock(home);
      expect(stale.held).toBe(false);
    }
    expect(existsSync(clearingPath)).toBe(false);
    // The dead lock was never touched by the run that only removed the clearing lock.
    expect(readFileSync(join(home, "sync.lock"), "utf8")).toBe(deadLock);
    using next = acquireSyncLock(home);
    expect(next.held).toBe(true);
  });

  test("an old clearing lock naming a live process (a reused pid) is removed too", async () => {
    const home = configuredHome();
    writeFileSync(join(home, "sync.lock"), String(await deadPid()));
    const clearingPath = join(home, SYNC_CLEARING_FILE);
    const sleeper = Bun.spawn(["sleep", "60"]);
    try {
      writeFileSync(clearingPath, String(sleeper.pid));
      {
        using fresh = acquireSyncLock(home);
        expect(fresh.held).toBe(false);
      }
      expect(existsSync(clearingPath)).toBe(true);
      const old = new Date(Date.now() - CLEARING_STALE_MS - 1_000);
      utimesSync(clearingPath, old, old);
      {
        using stale = acquireSyncLock(home);
        expect(stale.held).toBe(false);
      }
      expect(existsSync(clearingPath)).toBe(false);
      using next = acquireSyncLock(home);
      expect(next.held).toBe(true);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  test("the clearing lock is released after a clear", async () => {
    const home = configuredHome();
    writeFileSync(join(home, "sync.lock"), String(await deadPid()));
    using lock = acquireSyncLock(home);
    expect(lock.held).toBe(true);
    expect(existsSync(join(home, SYNC_CLEARING_FILE))).toBe(false);
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

  test("--push and --pull exit 75 (temporary failure): a script that asked for the push got nothing", async () => {
    const home = configuredHome();
    writeFileSync(join(home, "sync.lock"), String(process.pid));
    for (const flag of ["--push", "--pull"]) {
      const result = await tempad(["sync", flag], home);
      expect(result.code).toBe(75);
      expect(result.stderr.trim()).toBe(SYNC_BUSY_MESSAGE);
    }
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
