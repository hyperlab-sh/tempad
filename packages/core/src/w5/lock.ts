import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";

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
  /** Which rule made it stale; absent when it is not. */
  reason?: "past-ceiling" | "no-pid" | "runner-gone";
}

/**
 * A lock is stale when it has not been touched for `STALE_LOCK_MINUTES` and the
 * runner that wrote it is gone, or when it is older than `LOCK_MAX_HOLD_HOURS`
 * whatever its pid says. Age alone is not enough: a laptop that sleeps through
 * a job wakes with a lock that looks 30 minutes old and a runner that is fine.
 * A lock that vanishes before it can be read (another runner cleared or released
 * it) is no lock: not stale, nothing to clear.
 */
export function checkLock(
  lockPath: string,
  options: { now?: number; isAlive?: (pid: number) => boolean } = {},
): LockCheck {
  const now = options.now ?? Date.now();
  const isAlive = options.isAlive ?? pidIsAlive;
  let modifiedMs: number;
  try {
    modifiedMs = statSync(lockPath).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { stale: false, ageMinutes: 0 };
    throw error;
  }
  const ageMinutes = (now - modifiedMs) / 60_000;
  if (ageMinutes < STALE_LOCK_MINUTES) return { stale: false, ageMinutes };
  if (ageMinutes >= LOCK_MAX_HOLD_HOURS * 60) {
    return { stale: true, ageMinutes, reason: "past-ceiling" };
  }
  const pid = lockPid(lockPath);
  if (pid === null) return { stale: true, ageMinutes, reason: "no-pid" };
  if (!isAlive(pid)) return { stale: true, ageMinutes, reason: "runner-gone" };
  return { stale: false, ageMinutes };
}

/**
 * Removes the lock when it is stale; returns whether it did. Check, then unlink:
 * two runners can both judge one lock stale and both remove it, and one may
 * unlink a lock the other has just taken. That is harmless. The lock only saves
 * duplicate work; what guarantees a job is applied once is its claim
 * (`holdsClaim`, `src/w5/jobs.ts`), which a lost lock does not touch.
 */
export function clearStaleLock(
  lockPath: string,
  log: (line: string) => void,
  options: { now?: number; isAlive?: (pid: number) => boolean; name?: string } = {},
): boolean {
  if (!existsSync(lockPath)) return false;
  const { stale, ageMinutes, reason } = checkLock(lockPath, options);
  if (!stale) return false;
  const why = {
    "past-ceiling": `older than the ${LOCK_MAX_HOLD_HOURS}h hold ceiling, whatever its pid`,
    "no-pid": "no pid in it",
    "runner-gone": "its runner is not running",
    undefined: "stale",
  }[String(reason)];
  log(
    `${options.name ?? "w5.lock"} is stale (${Math.round(ageMinutes)}m untouched, ${why}), removing`,
  );
  try {
    unlinkSync(lockPath);
  } catch (error) {
    // already gone: another runner cleared it first
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return true;
}

/** Marks the lock as held right now; a runner calls it before each job. */
export function touchLock(lockPath: string): void {
  try {
    const now = new Date();
    utimesSync(lockPath, now, now);
  } catch {
    // the lock was cleared under us; the job claim, not the lock, guards the result
  }
}

/**
 * Takes the lock with O_EXCL, so of two runners spawned together exactly one
 * gets it (an exists-check followed by a write lets both through). Returns false
 * when someone else holds it. The directory must exist.
 */
export function acquireLock(lockPath: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(descriptor, String(process.pid));
  } finally {
    closeSync(descriptor);
  }
  return true;
}

/**
 * Removes the lock only when it is this process's. Another runner may have
 * cleared ours as stale and taken its own, and unlinking by path would delete
 * that one.
 */
export function releaseLock(lockPath: string): boolean {
  if (lockPid(lockPath) !== process.pid) return false;
  try {
    unlinkSync(lockPath);
  } catch {
    return false;
  }
  return true;
}
