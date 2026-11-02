import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { enqueueJob } from "./jobs";

/**
 * `hooks/w5-stop.sh` runs inside Claude Code's endSession window and is cancelled
 * when it is slow, and starting bun is slow. So it appends one request per line to
 * `TEMPAD_HOME/w5-spool` and exits; `tempad w5 run` drains the spool into `w5_jobs`
 * before and after its job loop. A line is `<iso time>\t<session id>\t<kind>\t<0|1 forced>`
 * (`w5_spool_enqueue` in `hooks/w5-common.sh`).
 */
export const SPOOL_FILE_NAME = "w5-spool";
const DRAINING_PREFIX = `${SPOOL_FILE_NAME}.draining.`;

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const KINDS = new Set(["classify", "session_end"]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export interface SpoolDrainResult {
  enqueued: number;
  /** Requests folded into a queued job or skipped by the throttle. */
  merged: number;
  /** Lines that were not a well-formed request. */
  malformed: number;
}

function drainingFiles(home: string): string[] {
  return readdirSync(home)
    .filter((name) => name.startsWith(DRAINING_PREFIX))
    .sort()
    .map((name) => join(home, name));
}

/** True when a hook appended a request, or a drain died before finishing one. */
export function spoolPending(home: string): boolean {
  return existsSync(join(home, SPOOL_FILE_NAME)) || drainingFiles(home).length > 0;
}

/**
 * Turns every spooled request into an `enqueueJob`, in the order the hooks wrote
 * them, each at the time the hook recorded (so the throttle compares the moment of
 * the Stop with the last run, not the moment of the drain).
 *
 * The spool is renamed away first (atomic; a hook that appends afterwards starts a
 * fresh `w5-spool`) and the renamed file is deleted only after its requests were
 * enqueued in one transaction. A crash in between leaves `w5-spool.draining.<pid>`,
 * which the next drain replays: enqueueing twice folds into the one queued job.
 * Those leftovers hold older requests than the live spool, so they are replayed
 * before the live spool is renamed: replaying after it would order requests by pid,
 * and the rename could overwrite a leftover that carries this process's pid.
 */
export function drainSpool(
  database: Database,
  home: string,
  options: { throttleMinutes: number; log: (line: string) => void },
): SpoolDrainResult {
  const result: SpoolDrainResult = { enqueued: 0, merged: 0, malformed: 0 };
  const replay = (path: string): void => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const apply = database.transaction(() => {
      for (const line of text.split("\n")) {
        if (line === "") continue;
        const [at, sessionId, kind, forced, ...extra] = line.split("\t");
        if (
          extra.length > 0 ||
          at === undefined ||
          !ISO_TIME.test(at) ||
          Number.isNaN(Date.parse(at)) ||
          sessionId === undefined ||
          !SESSION_ID.test(sessionId) ||
          kind === undefined ||
          !KINDS.has(kind) ||
          (forced !== "0" && forced !== "1")
        ) {
          options.log(`spool: skipping malformed line ${JSON.stringify(line.slice(0, 200))}`);
          result.malformed += 1;
          continue;
        }
        const outcome = enqueueJob(database, {
          sessionId,
          forced: forced === "1",
          now: at,
          throttleMinutes: options.throttleMinutes,
          kind,
        });
        if (outcome.enqueued) result.enqueued += 1;
        else result.merged += 1;
      }
    });
    apply();
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  for (const path of drainingFiles(home)) replay(path);

  const spool = join(home, SPOOL_FILE_NAME);
  if (!existsSync(spool)) return result;
  const draining = join(home, `${DRAINING_PREFIX}${process.pid}`);
  try {
    renameSync(spool, draining);
  } catch (error) {
    // Another runner took it between the check and the rename.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  replay(draining);
  return result;
}
