import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  checkLock,
  clearStaleLock,
  LOCK_MAX_HOLD_HOURS,
  lockPid,
  pidIsAlive,
  releaseLock,
  STALE_LOCK_MINUTES,
  touchLock,
} from "../../src/w5/lock";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");

function withLock(content: string, ageMinutes: number, run: (lockPath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tempad-lock-test-"));
  try {
    const lockPath = join(directory, "w5.lock");
    writeFileSync(lockPath, content);
    const modified = new Date(NOW - ageMinutes * 60_000);
    utimesSync(lockPath, modified, modified);
    run(lockPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A pid that belonged to a process that has exited. */
function deadPid(): number {
  return Bun.spawnSync(["true"]).pid;
}

describe("pidIsAlive", () => {
  test("this process is alive, an exited one is not", () => {
    expect(pidIsAlive(process.pid)).toBe(true);
    expect(pidIsAlive(deadPid())).toBe(false);
  });
});

describe("lockPid", () => {
  test("reads a pid and rejects anything else", () => {
    withLock("4242\n", 0, (path) => expect(lockPid(path)).toBe(4242));
    withLock("", 0, (path) => expect(lockPid(path)).toBeNull());
    withLock("not a pid", 0, (path) => expect(lockPid(path)).toBeNull());
    withLock("0", 0, (path) => expect(lockPid(path)).toBeNull());
    withLock("12 34", 0, (path) => expect(lockPid(path)).toBeNull());
  });
});

describe("checkLock", () => {
  test("a lock younger than the stale age is never stale, whatever its pid", () => {
    withLock("999999", STALE_LOCK_MINUTES - 1, (path) => {
      expect(checkLock(path, { now: NOW, isAlive: () => false }).stale).toBe(false);
    });
  });

  test("an old lock whose runner is alive is not stale: a sleeping laptop is not a dead runner", () => {
    withLock(String(process.pid), STALE_LOCK_MINUTES + 90, (path) => {
      expect(checkLock(path, { now: NOW }).stale).toBe(false);
    });
  });

  test("an old lock whose runner is gone is stale, from the stale age on", () => {
    withLock("4242", STALE_LOCK_MINUTES, (path) => {
      expect(checkLock(path, { now: NOW, isAlive: () => false }).stale).toBe(true);
    });
    withLock("4242", STALE_LOCK_MINUTES, (path) => {
      expect(checkLock(path, { now: NOW, isAlive: () => true }).stale).toBe(false);
    });
  });

  test("an old lock with no readable pid is stale", () => {
    withLock("", STALE_LOCK_MINUTES + 1, (path) => {
      expect(checkLock(path, { now: NOW, isAlive: () => true }).stale).toBe(true);
    });
  });

  test("a lock past the hold ceiling is stale even when its pid answers (a reused pid)", () => {
    withLock("4242", LOCK_MAX_HOLD_HOURS * 60 - 1, (path) => {
      expect(checkLock(path, { now: NOW, isAlive: () => true }).stale).toBe(false);
    });
    withLock("4242", LOCK_MAX_HOLD_HOURS * 60, (path) => {
      expect(checkLock(path, { now: NOW, isAlive: () => true }).stale).toBe(true);
    });
  });
});

describe("clearStaleLock", () => {
  test("removes a stale lock and logs it", () => {
    withLock("4242", STALE_LOCK_MINUTES + 5, (path) => {
      const lines: string[] = [];
      expect(
        clearStaleLock(path, (line) => lines.push(line), { now: NOW, isAlive: () => false }),
      ).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(lines.join("\n")).toContain("stale");
    });
  });

  test("keeps a lock held by a live runner", () => {
    withLock("4242", STALE_LOCK_MINUTES + 5, (path) => {
      expect(clearStaleLock(path, () => {}, { now: NOW, isAlive: () => true })).toBe(false);
      expect(existsSync(path)).toBe(true);
    });
  });

  test("a missing lock is nothing to clear", () => {
    expect(clearStaleLock("/nonexistent/w5.lock", () => {})).toBe(false);
  });
});

describe("touchLock", () => {
  test("moves the lock's age back to zero and keeps its pid", () => {
    withLock(String(process.pid), 120, (path) => {
      touchLock(path);
      expect((Date.now() - statSync(path).mtimeMs) / 60_000).toBeLessThan(1);
      expect(lockPid(path)).toBe(process.pid);
    });
  });

  test("a lock that is gone is ignored", () => {
    expect(() => touchLock("/nonexistent/w5.lock")).not.toThrow();
  });
});

describe("clearStaleLock names the rule that made the lock stale", () => {
  test("a dead runner", () => {
    withLock(String(deadPid()), STALE_LOCK_MINUTES + 5, (path) => {
      const lines: string[] = [];
      clearStaleLock(path, (line) => lines.push(line), { now: NOW });
      expect(lines.join("\n")).toContain("its runner is not running");
    });
  });

  test("past the hold ceiling, even though the pid is alive", () => {
    withLock(String(process.pid), LOCK_MAX_HOLD_HOURS * 60 + 1, (path) => {
      const lines: string[] = [];
      expect(clearStaleLock(path, (line) => lines.push(line), { now: NOW })).toBe(true);
      const line = lines.join("\n");
      expect(line).toContain(`${LOCK_MAX_HOLD_HOURS}h hold ceiling`);
      expect(line).not.toContain("not running");
    });
  });

  test("a lock with no readable pid", () => {
    withLock("garbage", STALE_LOCK_MINUTES + 5, (path) => {
      const lines: string[] = [];
      clearStaleLock(path, (line) => lines.push(line), { now: NOW });
      expect(lines.join("\n")).toContain("no pid in it");
    });
  });
});

describe("acquireLock and releaseLock", () => {
  function inTemporaryDirectory(run: (lockPath: string) => void): void {
    const directory = mkdtempSync(join(tmpdir(), "tempad-lock-test-"));
    try {
      run(join(directory, "w5.lock"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test("the first caller takes the lock with its pid, a second is refused", () => {
    inTemporaryDirectory((lockPath) => {
      expect(acquireLock(lockPath)).toBe(true);
      expect(lockPid(lockPath)).toBe(process.pid);
      expect(acquireLock(lockPath)).toBe(false);
      expect(lockPid(lockPath)).toBe(process.pid);
    });
  });

  test("an existing lock, whoever's, is never overwritten", () => {
    inTemporaryDirectory((lockPath) => {
      writeFileSync(lockPath, "4242");
      expect(acquireLock(lockPath)).toBe(false);
      expect(lockPid(lockPath)).toBe(4242);
    });
  });

  test("a missing directory is an error, not a refusal", () => {
    expect(() => acquireLock("/nonexistent-tempad-dir/w5.lock")).toThrow();
  });

  test("racing processes: exactly one acquires", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-lock-race-"));
    try {
      const lockPath = join(directory, "w5.lock");
      const script = `
        import { acquireLock } from ${JSON.stringify(join(import.meta.dir, "../../src/w5/lock"))};
        while (Date.now() < Number(process.argv[2])) {}
        console.log(acquireLock(process.argv[1]) ? "won" : "lost");
        await Bun.sleep(300);
      `;
      const startAt = String(Date.now() + 1500);
      const racers = Array.from({ length: 6 }, () =>
        Bun.spawn(["bun", "--no-env-file", "-e", script, lockPath, startAt], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const results = await Promise.all(
        racers.map(async (racer) => (await new Response(racer.stdout).text()).trim()),
      );
      expect(results.filter((result) => result === "won")).toHaveLength(1);
      expect(results.filter((result) => result === "lost")).toHaveLength(5);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("releaseLock removes this process's lock only", () => {
    inTemporaryDirectory((lockPath) => {
      writeFileSync(lockPath, String(process.pid));
      expect(releaseLock(lockPath)).toBe(true);
      expect(existsSync(lockPath)).toBe(false);

      writeFileSync(lockPath, String(deadPid()));
      expect(releaseLock(lockPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);

      writeFileSync(lockPath, "not a pid");
      expect(releaseLock(lockPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    });
  });

  test("releaseLock on a missing lock is a no-op", () => {
    expect(releaseLock("/nonexistent-tempad-dir/w5.lock")).toBe(false);
  });
});

describe("a lock that vanishes mid-check is no lock", () => {
  test("checkLock on a missing lock is not stale and does not throw", () => {
    expect(checkLock("/nonexistent-tempad-dir/w5.lock", { now: NOW })).toEqual({
      stale: false,
      ageMinutes: 0,
    });
  });

  test("checkLock still throws anything but ENOENT", () => {
    withLock("1", 0, (path) => {
      // A path through a regular file fails with ENOTDIR, not ENOENT.
      expect(() => checkLock(`${path}/inside`, { now: NOW })).toThrow();
    });
  });

  test("another runner removing the lock between the stale verdict and the unlink is fine", () => {
    withLock(String(deadPid()), STALE_LOCK_MINUTES + 5, (path) => {
      const lines: string[] = [];
      const cleared = clearStaleLock(
        path,
        (line) => {
          lines.push(line);
          rmSync(path);
        },
        { now: NOW },
      );
      expect(cleared).toBe(true);
      expect(lines).toHaveLength(1);
      expect(existsSync(path)).toBe(false);
    });
  });

  test("clearStaleLock on a missing lock does nothing", () => {
    expect(clearStaleLock("/nonexistent-tempad-dir/w5.lock", () => {}, { now: NOW })).toBe(false);
  });
});
