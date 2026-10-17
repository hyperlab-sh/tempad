import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLock,
  clearStaleLock,
  LOCK_MAX_HOLD_HOURS,
  lockPid,
  pidIsAlive,
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
