import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  CLEARING_STALE_MS,
  checkLock,
  clearingPathFor,
  clearStaleLock,
  LOCK_MAX_HOLD_HOURS,
  lockPid,
  pidIsAlive,
  releaseLock,
  STALE_LOCK_MINUTES,
  touchLock,
  tryClearStaleLock,
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

describe("tryClearStaleLock", () => {
  test("a lock another run replaced after the first verdict is not removed", () => {
    withLock(String(deadPid()), STALE_LOCK_MINUTES + 5, (path) => {
      const outcome = tryClearStaleLock(path, () => {}, {
        now: NOW,
        afterJudgedStale: () => {
          rmSync(path);
          writeFileSync(path, String(process.pid));
          utimesSync(path, new Date(NOW), new Date(NOW));
        },
      });
      expect(outcome).toBe("not-stale");
      expect(lockPid(path)).toBe(process.pid);
      expect(existsSync(clearingPathFor(path))).toBe(false);
    });
  });

  test("skips while another run holds the clearing handoff, leaving both files alone", () => {
    withLock("4242", STALE_LOCK_MINUTES + 5, (path) => {
      writeFileSync(clearingPathFor(path), String(process.pid));
      const outcome = tryClearStaleLock(path, () => {}, { now: NOW, isAlive: () => false });
      expect(outcome).toBe("contended");
      expect(existsSync(path)).toBe(true);
      expect(existsSync(clearingPathFor(path))).toBe(true);
    });
  });

  test("an abandoned handoff (its clearer is dead) is removed and the same call then clears", () => {
    withLock("4242", STALE_LOCK_MINUTES + 5, (path) => {
      const clearing = clearingPathFor(path);
      writeFileSync(clearing, String(deadPid()));
      expect(tryClearStaleLock(path, () => {}, { now: NOW, isAlive: (pid) => pid === 0 })).toBe(
        "cleared",
      );
      expect(existsSync(path)).toBe(false);
      expect(existsSync(clearing)).toBe(false);
    });
  });

  test("a handoff with no pid is left for 10 s, then removed and the same call clears", () => {
    withLock("4242", STALE_LOCK_MINUTES + 5, (path) => {
      const clearing = clearingPathFor(path);
      writeFileSync(clearing, "");
      const options = { now: NOW, isAlive: () => false };
      expect(tryClearStaleLock(path, () => {}, options)).toBe("contended");
      expect(existsSync(clearing)).toBe(true);
      const abandoned = new Date(Date.now() - CLEARING_STALE_MS - 1_000);
      utimesSync(clearing, abandoned, abandoned);
      expect(tryClearStaleLock(path, () => {}, options)).toBe("cleared");
      expect(existsSync(path)).toBe(false);
      expect(existsSync(clearing)).toBe(false);
    });
  });

  test("a handoff whose clearer is alive is kept past 10 s (a stopped clearer) and removed only after the 30 minute rule", () => {
    withLock("4242", STALE_LOCK_MINUTES + 5, (path) => {
      const clearing = clearingPathFor(path);
      writeFileSync(clearing, "4343");
      // 4242 (the lock's runner) is gone, 4343 (the clearer, or a reused pid) is alive
      const options = { now: NOW, isAlive: (pid: number) => pid === 4343 };
      const tenSecondsOld = new Date(Date.now() - CLEARING_STALE_MS - 1_000);
      utimesSync(clearing, tenSecondsOld, tenSecondsOld);
      expect(tryClearStaleLock(path, () => {}, options)).toBe("contended");
      expect(existsSync(clearing)).toBe(true);
      expect(existsSync(path)).toBe(true);

      const old = new Date(Date.now() - (STALE_LOCK_MINUTES + 1) * 60_000);
      utimesSync(clearing, old, old);
      expect(tryClearStaleLock(path, () => {}, options)).toBe("cleared");
      expect(existsSync(clearing)).toBe(false);
    });
  });

  test("a grace of 0 clears a dead runner's fresh lock but never a pid-less one", () => {
    withLock("4242", 0, (path) => {
      const options = { now: NOW, isAlive: () => false, deadRunnerGraceMinutes: 0 };
      expect(tryClearStaleLock(path, () => {}, options)).toBe("cleared");
    });
    withLock("", 0, (path) => {
      const options = { now: NOW, isAlive: () => false, deadRunnerGraceMinutes: 0 };
      expect(tryClearStaleLock(path, () => {}, options)).toBe("not-stale");
      expect(existsSync(path)).toBe(true);
    });
  });
});

describe("racing processes over a stale lock: exactly one takes it", () => {
  const RACERS = 8;
  const LOCK_MODULE = JSON.stringify(join(import.meta.dir, "../../src/w5/lock"));
  const SYNC_LOCK_MODULE = JSON.stringify(join(import.meta.dir, "../../src/sync/lock"));

  /**
   * Every racer waits for the same instant, judges the stale lock, and waits for fixed later
   * instants (absolute, so a racer that started late still joins) before it takes the clearing
   * handoff and again before it unlinks, each racer 40 ms after the one before it. The second
   * wait is the window in
   * which, without the handoff, every racer has judged the lock stale a second time: one
   * unlinks it and takes a fresh lock, the next unlinks that live lock and takes its own.
   * It prints `won` only when it holds the lock afterwards, then stays alive long enough that a
   * winner's lock is not judged dead by a slower racer.
   */
  const w5Racer = `
    import { acquireLock, clearStaleLock } from ${LOCK_MODULE};
    const startAt = Number(process.argv[2]);
    const waitUntil = (time) => Bun.sleepSync(Math.max(0, time - Date.now()));
    waitUntil(startAt);
    clearStaleLock(process.argv[1], () => {}, {
      afterJudgedStale: () => waitUntil(startAt + 300),
      beforeUnlink: () => waitUntil(startAt + 600 + 40 * Number(process.argv[3])),
    });
    console.log(acquireLock(process.argv[1]) ? "won" : "lost");
    await Bun.sleep(300);
  `;
  const syncRacer = `
    import { acquireSyncLock } from ${SYNC_LOCK_MODULE};
    const startAt = Number(process.argv[1]);
    const waitUntil = (time) => Bun.sleepSync(Math.max(0, time - Date.now()));
    waitUntil(startAt);
    const lock = acquireSyncLock(process.argv[2], () => {}, {
      afterJudgedDead: () => waitUntil(startAt + 300),
      beforeUnlink: () => waitUntil(startAt + 600 + 40 * Number(process.argv[3])),
    });
    console.log(lock.held ? "won" : "lost");
    await Bun.sleep(300);
  `;

  async function race(script: string, args: (startAt: string) => string[]): Promise<string[]> {
    const startAt = String(Date.now() + 800);
    const racers = Array.from({ length: RACERS }, (_, index) =>
      Bun.spawn(["bun", "--no-env-file", "-e", script, ...args(startAt), String(index)], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    return Promise.all(
      racers.map(async (racer) => {
        const [out, err] = await Promise.all([
          new Response(racer.stdout).text(),
          new Response(racer.stderr).text(),
        ]);
        if (err.trim()) throw new Error(`racer failed: ${err}`);
        return out.trim();
      }),
    );
  }

  function expectOneWinner(results: string[]): void {
    expect(results.filter((result) => result === "won")).toHaveLength(1);
    expect(results.filter((result) => result === "lost")).toHaveLength(RACERS - 1);
  }

  async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "tempad-lock-stale-race-"));
    try {
      await run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const old = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  const w5Cases: { name: string; content: () => string; ageMinutes: number }[] = [
    {
      name: "its runner is gone",
      content: () => String(deadPid()),
      ageMinutes: STALE_LOCK_MINUTES + 1,
    },
    { name: "it holds no pid", content: () => "", ageMinutes: STALE_LOCK_MINUTES + 1 },
    {
      name: "it is past the hold ceiling with a live pid",
      content: () => String(process.pid),
      ageMinutes: LOCK_MAX_HOLD_HOURS * 60 + 1,
    },
  ];

  for (const { name, content, ageMinutes } of w5Cases) {
    test(`w5.lock, ${name}`, async () => {
      await withDirectory(async (directory) => {
        const lockPath = join(directory, "w5.lock");
        writeFileSync(lockPath, content());
        utimesSync(lockPath, old(ageMinutes), old(ageMinutes));
        expectOneWinner(await race(w5Racer, (startAt) => [lockPath, startAt]));
        expect(readdirSync(directory).sort()).toEqual(["w5.lock"]);
      });
    });
  }

  test("sync.lock, its runner is gone (no grace)", async () => {
    await withDirectory(async (directory) => {
      writeFileSync(join(directory, ".env"), "");
      writeFileSync(join(directory, "sync.lock"), String(deadPid()));
      expectOneWinner(await race(syncRacer, (startAt) => [startAt, directory]));
      expect(readdirSync(directory).sort()).toEqual([".env", "sync.lock"]);
    });
  });

  test("sync.lock, it holds no pid and is older than the grace", async () => {
    await withDirectory(async (directory) => {
      writeFileSync(join(directory, ".env"), "");
      const lockPath = join(directory, "sync.lock");
      writeFileSync(lockPath, "");
      utimesSync(lockPath, old(STALE_LOCK_MINUTES + 1), old(STALE_LOCK_MINUTES + 1));
      expectOneWinner(await race(syncRacer, (startAt) => [startAt, directory]));
    });
  });
});
