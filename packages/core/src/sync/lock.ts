import { existsSync } from "node:fs";
import { join } from "node:path";
import { isConfigured } from "../config/env.ts";
import { acquireLock, clearStaleLock, releaseLock } from "../w5/lock.ts";

/**
 * One collecting sync at a time per `TEMPAD_HOME`. A scheduled `tempad sync`, a manual one and
 * a second scheduled run that starts while the first still works would otherwise run the same
 * collectors side by side: two `git clone --mirror`/`fetch` calls in one mirror directory fail
 * on git's own locks, and every collector fetches the same pages twice. The database tolerates
 * it (each write waits up to `busy_timeout`, and every upsert is idempotent), so the lock saves
 * work and spurious failures; it guards no data.
 *
 * It is the `w5.lock` mechanism (`w5/lock.ts`) under another name: taken with `O_EXCL`, stale
 * once untouched for 30 minutes and its runner is gone (or past the 6 h ceiling).
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
  clearStaleLock(lockPath, log, { name: SYNC_LOCK_FILE });
  if (!acquireLock(lockPath)) return { held: false, [Symbol.dispose]() {} };
  return {
    held: true,
    [Symbol.dispose]() {
      releaseLock(lockPath);
    },
  };
}

export const SYNC_BUSY_MESSAGE = `sync: another sync is already running; skipping (its ${SYNC_LOCK_FILE} in TEMPAD_HOME is cleared when it ends, or 30 minutes after a crash)`;
