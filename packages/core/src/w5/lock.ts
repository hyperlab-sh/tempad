import {
  closeSync,
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
  /** The pid the lock named when the verdict was `runner-gone`. */
  pid?: number;
}

export interface LockCheckOptions {
  now?: number;
  isAlive?: (pid: number) => boolean;
  /**
   * How long a lock whose runner is gone is left alone before it counts as stale; defaults to
   * `STALE_LOCK_MINUTES`. `sync.lock` passes 0: a sync killed by a signal leaves its lock
   * behind, and the grace would make every run in the next half hour skip. It never applies to
   * a lock with no pid, which may be a holder that has not written its pid yet.
   */
  deadRunnerGraceMinutes?: number;
}

/**
 * A lock is stale when it has not been touched for `STALE_LOCK_MINUTES` and the
 * runner that wrote it is gone, or when it is older than `LOCK_MAX_HOLD_HOURS`
 * whatever its pid says. Age alone is not enough: a laptop that sleeps through
 * a job wakes with a lock that looks 30 minutes old and a runner that is fine.
 * A lock naming this process is never judged dead. A lock that vanishes before
 * it can be read (another runner cleared or released it) is no lock: not stale,
 * nothing to clear.
 */
export function checkLock(lockPath: string, options: LockCheckOptions = {}): LockCheck {
  const now = options.now ?? Date.now();
  const isAlive = options.isAlive ?? pidIsAlive;
  const deadRunnerGrace = options.deadRunnerGraceMinutes ?? STALE_LOCK_MINUTES;
  let modifiedMs: number;
  try {
    modifiedMs = statSync(lockPath).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { stale: false, ageMinutes: 0 };
    throw error;
  }
  // a file stamped a few ms ahead of the clock reads as negative age; with a 0 grace that is not 'old enough'
  const ageMinutes = Math.max(0, now - modifiedMs) / 60_000;
  if (ageMinutes >= LOCK_MAX_HOLD_HOURS * 60) {
    return { stale: true, ageMinutes, reason: "past-ceiling" };
  }
  const pid = lockPid(lockPath);
  if (pid === null) {
    return ageMinutes >= STALE_LOCK_MINUTES
      ? { stale: true, ageMinutes, reason: "no-pid" }
      : { stale: false, ageMinutes };
  }
  if (pid === process.pid || isAlive(pid)) return { stale: false, ageMinutes };
  return ageMinutes >= deadRunnerGrace
    ? { stale: true, ageMinutes, reason: "runner-gone", pid }
    : { stale: false, ageMinutes };
}

/** The critical section is microseconds; a clearing lock older than this was abandoned, whatever its pid says. */
export const CLEARING_STALE_MS = 10_000;

/** The handoff file that serializes clearing `lockPath`. */
export function clearingPathFor(lockPath: string): string {
  return `${lockPath}.clearing`;
}

/** Test seams: what runs between judging the lock stale and taking the handoff, and between the second judgment and the unlink. */
export interface ClearStaleLockOptions extends LockCheckOptions {
  name?: string;
  afterJudgedStale?: () => void;
  beforeUnlink?: () => void;
}

export type ClearOutcome =
  /** Not stale, or gone: nothing to clear. */
  | "not-stale"
  /** This call removed the stale lock. */
  | "cleared"
  /** Another run holds the clearing handoff (or just abandoned one): skip this run's work. */
  | "contended";

/**
 * Removes the lock when it is stale, atomically with respect to other runs doing the same.
 *
 * Check-then-unlink is not enough: two runs can both judge one lock stale, one unlinks it and
 * takes a fresh lock, and the other then unlinks that live lock and takes its own, so both run.
 * So the clear is serialized by `<lock>.clearing`, taken with `O_EXCL` and held only while the
 * lock is judged again and unlinked. The second judgment is what makes the first one safe to
 * act on: a lock another run took in between is fresh (or names a live runner) and is left
 * alone, and nothing else unlinks a lock file that exists (`O_EXCL` creation fails while it
 * does, and `releaseLock` only removes its own pid's). A run that finds the handoff taken
 * returns `contended` instead of waiting: the critical section takes microseconds, and whoever
 * holds it is doing this very clear. A handoff left by a clearer that died inside that window is
 * removed by the next run, which then retries its own clear once, when its pid is gone, when it
 * names no pid and is older than `CLEARING_STALE_MS`, or when it names a live pid and is older than
 * `STALE_LOCK_MINUTES` (a stopped clearer is not abandoned after 10 s, but a reused pid would
 * otherwise block every run forever); two runs removing that abandoned handoff at once is the one
 * remaining race, and it needs a crash inside the critical section first.
 * `releaseLock` unlinks by path after reading the pid, so a holder past the hold ceiling
 * releasing at the very moment it is cleared can still take down the lock a third run just
 * acquired; that needs a runner that held the lock for over six hours and is harmless to
 * correctness (a job is applied once by its claim, `holdsClaim`, `src/w5/jobs.ts`; the lock only
 * saves duplicate work).
 */
export function tryClearStaleLock(
  lockPath: string,
  log: (line: string) => void,
  options: ClearStaleLockOptions = {},
): ClearOutcome {
  if (!checkLock(lockPath, options).stale) return "not-stale";
  options.afterJudgedStale?.();

  const clearingPath = clearingPathFor(lockPath);
  if (!acquireLock(clearingPath)) {
    // An abandoned handoff is removed and the clear tried once more, so the run that finds one
    // does not report a holder that is not there; a second failure means someone else is clearing.
    if (!clearingIsStale(clearingPath, options.isAlive ?? pidIsAlive)) return "contended";
    removeIfPresent(clearingPath);
    if (!acquireLock(clearingPath)) return "contended";
  }
  try {
    const { stale, ageMinutes, reason, pid } = checkLock(lockPath, options);
    if (!stale) return "not-stale";
    const why = {
      "past-ceiling": `older than the ${LOCK_MAX_HOLD_HOURS}h hold ceiling, whatever its pid`,
      "no-pid": "no pid in it",
      "runner-gone": `its runner is not running (pid ${pid})`,
      undefined: "stale",
    }[String(reason)];
    log(
      `${options.name ?? "w5.lock"} is stale (${Math.round(ageMinutes)}m untouched, ${why}), removing`,
    );
    options.beforeUnlink?.();
    removeIfPresent(lockPath);
    return "cleared";
  } finally {
    releaseLock(clearingPath);
  }
}

/** `tryClearStaleLock` for a caller that only wants to know whether this call removed the lock. */
export function clearStaleLock(
  lockPath: string,
  log: (line: string) => void,
  options: ClearStaleLockOptions = {},
): boolean {
  return tryClearStaleLock(lockPath, log, options) === "cleared";
}

/**
 * A handoff is abandoned when its clearer is gone: its pid is dead, or it names no pid (a crash
 * before the pid was written) and is older than `CLEARING_STALE_MS`. A clearer whose pid is alive
 * keeps the handoff for `STALE_LOCK_MINUTES`, not 10 s: a process stopped between its second
 * judgment and its unlink (SIGSTOP, a sleeping laptop) is still the clearer and would, once
 * resumed, unlink whatever lock exists by then. Only a pid reused by an unrelated process
 * outlives that, and the age ends it.
 */
function clearingIsStale(clearingPath: string, isAlive: (pid: number) => boolean): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(clearingPath).mtimeMs;
  } catch {
    return false; // gone already: whoever held it finished
  }
  const clearer = lockPid(clearingPath);
  if (clearer === null) return ageMs > CLEARING_STALE_MS;
  if (clearer !== process.pid && !isAlive(clearer)) return true;
  return ageMs > STALE_LOCK_MINUTES * 60_000;
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    // already gone: another run cleared it first
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
