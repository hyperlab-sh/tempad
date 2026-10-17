import { existsSync, readFileSync, statSync, unlinkSync, utimesSync } from "node:fs";

/** A lock older than this whose runner is gone (or unknown) is cleared. */
export const STALE_LOCK_MINUTES = 30;
/**
 * A lock older than this is cleared even when its pid answers: a live runner
 * touches the lock before every job, so one that has not in this long is not
 * working, and the pid has been reused by an unrelated process.
 */
export const LOCK_MAX_HOLD_HOURS = 6;

/** Whether a process with this pid exists. EPERM means it exists but is not ours. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid a runner wrote into its lock, or null when the file holds no pid. */
export function lockPid(lockPath: string): number | null {
  try {
    const text = readFileSync(lockPath, "utf8").trim();
    if (!/^\d+$/.test(text)) return null;
    const pid = Number.parseInt(text, 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export interface LockCheck {
  stale: boolean;
  ageMinutes: number;
}

/**
 * A lock is stale when it has not been touched for `STALE_LOCK_MINUTES` and the
 * runner that wrote it is gone, or when it is older than `LOCK_MAX_HOLD_HOURS`
 * whatever its pid says. Age alone is not enough: a laptop that sleeps through
 * a job wakes with a lock that looks 30 minutes old and a runner that is fine.
 */
export function checkLock(
  lockPath: string,
  options: { now?: number; isAlive?: (pid: number) => boolean } = {},
): LockCheck {
  const now = options.now ?? Date.now();
  const isAlive = options.isAlive ?? pidIsAlive;
  const ageMinutes = (now - statSync(lockPath).mtimeMs) / 60_000;
  if (ageMinutes < STALE_LOCK_MINUTES) return { stale: false, ageMinutes };
  if (ageMinutes >= LOCK_MAX_HOLD_HOURS * 60) return { stale: true, ageMinutes };
  const pid = lockPid(lockPath);
  return { stale: pid === null || !isAlive(pid), ageMinutes };
}

/** Removes the lock when it is stale; returns whether it did. */
export function clearStaleLock(
  lockPath: string,
  log: (line: string) => void,
  options: { now?: number; isAlive?: (pid: number) => boolean } = {},
): boolean {
  if (!existsSync(lockPath)) return false;
  const { stale, ageMinutes } = checkLock(lockPath, options);
  if (!stale) return false;
  log(`w5.lock is stale (${Math.round(ageMinutes)}m old, runner not running), removing`);
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
  return true;
}

/** Marks the lock as held right now; a runner calls it before each job. */
export function touchLock(lockPath: string): void {
  try {
    const now = new Date();
    utimesSync(lockPath, now, now);
  } catch {
    // the lock was cleared under us; the job claim still guards the result
  }
}
