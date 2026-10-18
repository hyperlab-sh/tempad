import { existsSync, statSync, unlinkSync } from "node:fs";
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
 * not written its pid) is left alone.
 *
 * Clearing a dead lock is itself serialized by `sync.lock.clearing`, taken with `O_EXCL` and
 * held only while the dead lock is re-read and unlinked. Without it, two runs that both judged
 * the lock dead could interleave (one unlinks and takes a fresh lock, the other then unlinks that
 * live lock). With it the unlink happens only inside the critical section, after re-reading the
 * pid, and nothing can replace a lock file that exists: `O_EXCL` creation fails while it does,
 * and its dead holder cannot release it. A run that finds the clearing lock taken skips (it
 * returns `held: false`) instead of waiting. A clearing lock left by a clearer that died inside
 * that microsecond window is removed by the next run (and that run skips) once its pid is gone or
 * it is older than `CLEARING_STALE_MS`, whatever its pid says (a crash before the pid was written,
 * or a reused live pid, would otherwise block every sync forever); two runs removing it
 * at once is the one remaining race, and it needs a crash in the critical section first. A reused
 * live pid can keep a dead run's lock until the 6 h ceiling.
 */
export interface SyncLock {
  /** False when another sync holds the lock; the caller skips its run. */
  held: boolean;
  [Symbol.dispose](): void;
}

export const SYNC_LOCK_FILE = "sync.lock";

export const SYNC_CLEARING_FILE = "sync.lock.clearing";
/** The clearing critical section is microseconds; a clearing lock older than this was abandoned, whatever its pid says. */
export const CLEARING_STALE_MS = 10_000;

/** Test seams: what runs between a run judging the lock dead and clearing it, and the liveness check. */
export interface SyncLockHooks {
  afterJudgedDead?: () => void;
  isAlive?: (pid: number) => boolean;
}

export function acquireSyncLock(
  home: string,
  log: (line: string) => void = (line) => console.error(line),
  hooks: SyncLockHooks = {},
): SyncLock {
  const lockPath = join(home, SYNC_LOCK_FILE);
  const busy: SyncLock = { held: false, [Symbol.dispose]() {} };
  // An unconfigured home gets nothing created: the command fails on its own, right after this.
  if (!isConfigured(home) || !existsSync(home)) return { held: true, [Symbol.dispose]() {} };
  if (!clearDeadHolderLock(lockPath, log, hooks)) return busy;
  clearStaleLock(lockPath, log, { name: SYNC_LOCK_FILE });
  if (!acquireLock(lockPath)) return busy;
  return {
    held: true,
    [Symbol.dispose]() {
      releaseLock(lockPath);
    },
  };
}

/**
 * Removes the lock when its holder's pid is not running and is not this process. Returns false
 * when another run is clearing it right now (the caller skips).
 */
function clearDeadHolderLock(
  lockPath: string,
  log: (line: string) => void,
  hooks: SyncLockHooks,
): boolean {
  const isAlive = hooks.isAlive ?? pidIsAlive;
  const pid = lockPid(lockPath);
  if (pid === null || pid === process.pid || isAlive(pid)) return true;
  hooks.afterJudgedDead?.();

  const clearingPath = `${lockPath}.clearing`;
  if (!acquireLock(clearingPath)) {
    // Taken: another run is clearing, and the critical section takes microseconds. One that is
    // older than that, or whose pid is gone, was left by a clearer that died (possibly before it
    // wrote its pid, or with a pid since reused): remove it, and skip this run.
    if (clearingIsStale(clearingPath, isAlive)) removeIfPresent(clearingPath);
    return false;
  }
  try {
    // Under the clearing lock: only a lock still held by the dead pid we judged is removed.
    if (lockPid(lockPath) !== pid) return true;
    log(`${SYNC_LOCK_FILE} was left by a sync that is gone (pid ${pid}), removing`);
    removeIfPresent(lockPath);
  } finally {
    releaseLock(clearingPath);
  }
  return true;
}

function clearingIsStale(clearingPath: string, isAlive: (pid: number) => boolean): boolean {
  try {
    if (Date.now() - statSync(clearingPath).mtimeMs > CLEARING_STALE_MS) return true;
  } catch {
    return false; // gone already: whoever held it finished
  }
  const clearer = lockPid(clearingPath);
  return clearer !== null && clearer !== process.pid && !isAlive(clearer);
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export const SYNC_BUSY_MESSAGE = `sync: another sync is already running; skipping (${SYNC_LOCK_FILE} in TEMPAD_HOME is released when it ends; a killed run's lock is cleared by the next sync)`;
