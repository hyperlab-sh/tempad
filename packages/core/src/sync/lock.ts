import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isConfigured } from "../config/env.ts";
import { acquireLock, clearStaleLock, lockPid, pidIsAlive, releaseLock } from "../w5/lock.ts";

/**
 * One collecting sync at a time per `TEMPAD_HOME`. A scheduled `tempad sync`, a manual one and
 * a second scheduled run that starts while the first still works would otherwise run the same
 * collectors side by side: two `git clone --mirror`/`fetch` calls in one mirror directory fail
 * on git's own locks, and every collector fetches the same pages twice. The database tolerates
 * it (each write waits up to `busy_timeout`, and every upsert is idempotent), so the lock saves
 * work and spurious failures; it guards no data.
 *
 * It is the `w5.lock` mechanism (`w5/lock.ts`) under another name: taken with `O_EXCL`, stale
 * past the 6 h ceiling whatever its pid says. Unlike `w5.lock` a sync does not wait out the 30
 * minute grace: a lock whose pid is gone (and is not ours) is cleared at once, because a sync
 * killed by SIGINT/SIGTERM leaves one behind and every run in the next half hour would falsely
 * report "already running". A lock with no pid yet (the holder created it a moment ago and has
 * not written its pid) is left alone. A reused pid can keep a dead run's lock for up to the 6 h
 * ceiling, and two runs that both find the same dead lock may both clear it; the lock saves
 * work and guards no data, so neither matters.
 */
export interface SyncLock {
  /** False when another sync holds the lock; the caller skips its run. */
  held: boolean;
  [Symbol.dispose](): void;
}

export const SYNC_LOCK_FILE = "sync.lock";

export function acquireSyncLock(
  home: string,
  log: (line: string) => void = (line) => console.error(line),
): SyncLock {
  const lockPath = join(home, SYNC_LOCK_FILE);
  // An unconfigured home gets nothing created: the command fails on its own, right after this.
  if (!isConfigured(home) || !existsSync(home)) return { held: true, [Symbol.dispose]() {} };
  clearDeadHolderLock(lockPath, log);
  clearStaleLock(lockPath, log, { name: SYNC_LOCK_FILE });
  if (!acquireLock(lockPath)) return { held: false, [Symbol.dispose]() {} };
  return {
    held: true,
    [Symbol.dispose]() {
      releaseLock(lockPath);
    },
  };
}

/** Removes the lock when its holder's pid is not running and is not this process. */
function clearDeadHolderLock(lockPath: string, log: (line: string) => void): void {
  const pid = lockPid(lockPath);
  if (pid === null || pid === process.pid || pidIsAlive(pid)) return;
  // Re-read just before unlinking, so a holder that replaced it in between is not removed.
  if (lockPid(lockPath) !== pid) return;
  log(`${SYNC_LOCK_FILE} was left by a sync that is gone (pid ${pid}), removing`);
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export const SYNC_BUSY_MESSAGE = `sync: another sync is already running; skipping (${SYNC_LOCK_FILE} in TEMPAD_HOME is released when it ends; a killed run's lock is cleared by the next sync)`;
