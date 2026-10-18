import { existsSync } from "node:fs";
import { join } from "node:path";
import { isConfigured } from "../config/env.ts";
import {
  acquireLock,
  CLEARING_STALE_MS,
  clearingPathFor,
  releaseLock,
  tryClearStaleLock,
} from "../w5/lock.ts";

/**
 * One collecting sync at a time per `TEMPAD_HOME`. A scheduled `tempad sync`, a manual one and
 * a second scheduled run that starts while the first still works would otherwise run the same
 * collectors side by side: two `git clone --mirror`/`fetch` calls in one mirror directory fail
 * on git's own locks, and every collector fetches the same pages twice. The database tolerates
 * it (each write waits up to `busy_timeout`, and every upsert is idempotent), so the lock saves
 * work and spurious failures; it guards no data.
 *
 * It is the `w5.lock` mechanism (`w5/lock.ts`, `tryClearStaleLock`, one implementation for both,
 * including the atomic `<lock>.clearing` handoff that makes two runs judging one lock stale
 * safe): taken with `O_EXCL`, stale past the 6 h ceiling whatever its pid says. Unlike `w5.lock`
 * a sync does not wait out the 30 minute grace: a lock whose pid is gone (and is not ours) is
 * cleared at once (`deadRunnerGraceMinutes: 0`), because a sync killed by SIGINT/SIGTERM leaves
 * one behind and every run in the next half hour would falsely report "already running". A lock
 * with no pid yet (the holder created it a moment ago and has not written its pid) is left alone
 * until the 30 minute age rule. A run that finds the clearing handoff taken skips (it returns
 * `held: false`) instead of waiting. A reused live pid can keep a dead run's lock until the 6 h
 * ceiling.
 */
export interface SyncLock {
  /** False when another sync holds the lock; the caller skips its run. */
  held: boolean;
  [Symbol.dispose](): void;
}

export const SYNC_LOCK_FILE = "sync.lock";

export const SYNC_CLEARING_FILE = clearingPathFor(SYNC_LOCK_FILE);
export { CLEARING_STALE_MS };

/** Test seams: what runs around clearing a lock judged dead (`ClearStaleLockOptions`), and the liveness check. */
export interface SyncLockHooks {
  afterJudgedDead?: () => void;
  beforeUnlink?: () => void;
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
  const outcome = tryClearStaleLock(lockPath, log, {
    name: SYNC_LOCK_FILE,
    deadRunnerGraceMinutes: 0,
    isAlive: hooks.isAlive,
    afterJudgedStale: hooks.afterJudgedDead,
    beforeUnlink: hooks.beforeUnlink,
  });
  if (outcome === "contended") return busy;
  if (!acquireLock(lockPath)) return busy;
  return {
    held: true,
    [Symbol.dispose]() {
      releaseLock(lockPath);
    },
  };
}

export const SYNC_BUSY_MESSAGE = `sync: another sync is already running; skipping (${SYNC_LOCK_FILE} in TEMPAD_HOME is released when it ends; a killed run's lock is cleared by the next sync)`;
