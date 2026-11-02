import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { defaultIntentConfig } from "../../src/intent/config";
import { ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { runW5Command, type SpawnFn } from "../../src/w5/cli";
import { completeJob, enqueueJob } from "../../src/w5/jobs";
import { drainSpool, SPOOL_FILE_NAME, spoolPending } from "../../src/w5/spool";

registerAllProjections();

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "tempad-spool-test-"));
}

function writeSpool(home: string, lines: string[], name = SPOOL_FILE_NAME): void {
  writeFileSync(join(home, name), lines.map((line) => `${line}\n`).join(""));
}

function makeConfig(home: string): Config {
  return {
    mondayApiToken: "t",
    mondayUser: "u",
    ghUser: "u",
    ghOrgs: [],
    ghIncludePersonal: false,
    ghToken: undefined,
    gitAuthorEmails: [],
    claudeDirs: [home],
    hostSlug: "host",
    tz: "UTC",
    since: "2020-01-01",
    syncToken: "unused",
    home,
  };
}

const T0 = "2026-10-28T10:00:00.000Z";
const T1 = "2026-10-28T10:30:00.000Z";
const options = (logged: string[] = []) => ({
  throttleMinutes: 10,
  log: (line: string) => logged.push(line),
});

describe("drainSpool", () => {
  test("turns each request into a job at the time the hook recorded and removes the spool", () => {
    const home = makeHome();
    try {
      const database = openDatabase(":memory:");
      writeSpool(home, [`${T0}\ts1\tclassify\t0`, `${T1}\ts2\tsession_end\t1`]);

      const result = drainSpool(database, home, options());

      expect(result).toEqual({ enqueued: 2, merged: 0, malformed: 0 });
      expect(
        database
          .query("SELECT session_id, kind, forced, requested_at FROM w5_jobs ORDER BY id")
          .all(),
      ).toEqual([
        { session_id: "s1", kind: "classify", forced: 0, requested_at: T0 },
        { session_id: "s2", kind: "session_end", forced: 1, requested_at: T1 },
      ]);
      expect(readdirSync(home)).toEqual([]);
      expect(spoolPending(home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("requests for one session fold like enqueue: session_end and forced stick", () => {
    const home = makeHome();
    try {
      const database = openDatabase(":memory:");
      writeSpool(home, [
        `${T0}\ts1\tclassify\t0`,
        `${T0}\ts1\tsession_end\t1`,
        `${T1}\ts1\tclassify\t0`,
      ]);

      const result = drainSpool(database, home, options());

      expect(result).toEqual({ enqueued: 1, merged: 2, malformed: 0 });
      expect(database.query("SELECT kind, forced FROM w5_jobs").all()).toEqual([
        { kind: "session_end", forced: 1 },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a Stop recorded before the session's last run is throttled by the time it happened", () => {
    const home = makeHome();
    try {
      const database = openDatabase(":memory:");
      enqueueJob(database, { sessionId: "s1", forced: false, now: T0, throttleMinutes: 10 });
      database.query("UPDATE w5_jobs SET state = 'running', claimed_at = ?").run(T0);
      completeJob(database, 1, null, "2026-10-28T10:20:00.000Z");
      writeSpool(home, [`2026-10-28T10:25:00.000Z\ts1\tclassify\t0`, `${T1}\ts1\tclassify\t0`]);

      const result = drainSpool(database, home, options());

      // 10:25 is 5 minutes after the run (throttled); 10:30 is 10 minutes after (queued).
      expect(result).toEqual({ enqueued: 1, merged: 1, malformed: 0 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("skips and logs malformed lines, keeps the good ones", () => {
    const home = makeHome();
    try {
      const database = openDatabase(":memory:");
      const logged: string[] = [];
      writeSpool(home, [
        "garbage",
        `${T0}\tbad id\tclassify\t0`,
        `${T0}\ts1\tmystery\t0`,
        `${T0}\ts1\tclassify\t2`,
        `not-a-time\ts1\tclassify\t0`,
        `${T0}\ts1\tclassify\t0\textra`,
        `${T0}\ts9\tclassify\t0`,
      ]);

      const result = drainSpool(database, home, options(logged));

      expect(result).toEqual({ enqueued: 1, merged: 0, malformed: 6 });
      expect(logged).toHaveLength(6);
      expect(database.query("SELECT session_id FROM w5_jobs").all()).toEqual([
        { session_id: "s9" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("replays a drain that died before it finished, then the live spool, in order", () => {
    const home = makeHome();
    try {
      const database = openDatabase(":memory:");
      writeSpool(home, [`${T0}\tleft-over\tclassify\t0`], `${SPOOL_FILE_NAME}.draining.4242`);
      writeSpool(home, [`${T1}\tfresh\tclassify\t0`]);
      expect(spoolPending(home)).toBe(true);

      drainSpool(database, home, options());

      expect(database.query("SELECT session_id FROM w5_jobs ORDER BY id").all()).toEqual([
        { session_id: "left-over" },
        { session_id: "fresh" },
      ]);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a leftover named after this process's pid is replayed, not overwritten by the live spool", () => {
    const home = makeHome();
    try {
      const database = openDatabase(":memory:");
      writeSpool(
        home,
        [`${T0}\tleft-over\tclassify\t0`],
        `${SPOOL_FILE_NAME}.draining.${process.pid}`,
      );
      writeSpool(home, [`${T1}\tfresh\tclassify\t0`]);

      drainSpool(database, home, options());

      expect(database.query("SELECT session_id FROM w5_jobs ORDER BY id").all()).toEqual([
        { session_id: "left-over" },
        { session_id: "fresh" },
      ]);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a missing spool and an empty one are no-ops", () => {
    const home = makeHome();
    try {
      const database = openDatabase(":memory:");
      expect(drainSpool(database, home, options())).toEqual({
        enqueued: 0,
        merged: 0,
        malformed: 0,
      });
      writeSpool(home, []);
      expect(drainSpool(database, home, options())).toEqual({
        enqueued: 0,
        merged: 0,
        malformed: 0,
      });
      expect(existsSync(join(home, SPOOL_FILE_NAME))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the spool and the runner", () => {
  const run = (home: string, args: string[], spawn: SpawnFn) => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    return runW5Command(args, {
      database,
      config: makeConfig(home),
      intentConfig: defaultIntentConfig(),
      stdout: () => {},
      spawn,
    });
  };

  test("w5 context starts a detached run when a request is spooled and the lock is free", async () => {
    const home = makeHome();
    try {
      writeSpool(home, [`${T0}\ts1\tclassify\t0`]);
      const calls: Parameters<SpawnFn>[0][] = [];

      await run(home, ["context", "--session", "s1"], (spawned) => {
        calls.push(spawned);
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.cmd).toContain("run");
      expect(calls[0]?.detached).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("w5 context starts nothing with an empty spool or a held lock", async () => {
    const home = makeHome();
    try {
      const calls: unknown[] = [];
      const spawn: SpawnFn = (spawned) => {
        calls.push(spawned);
      };

      await run(home, ["context", "--session", "s1"], spawn);
      writeSpool(home, [`${T0}\ts1\tclassify\t0`]);
      writeFileSync(join(home, "w5.lock"), String(process.pid));
      await run(home, ["context", "--session", "s1"], spawn);

      expect(calls).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("w5 run drains the spool into jobs and works them", async () => {
    const home = makeHome();
    try {
      writeSpool(home, [`${T0}\tno-such-session\tclassify\t1`]);
      const database = openDatabase(":memory:");

      const code = await runW5Command(["run"], {
        database,
        config: makeConfig(home),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn: () => {},
      });

      expect(code).toBe(0);
      expect(spoolPending(home)).toBe(false);
      const job = database.query("SELECT session_id, state, error FROM w5_jobs").get() as {
        session_id: string;
        state: string;
        error: string;
      };
      expect(job.session_id).toBe("no-such-session");
      expect(job.state).toBe("failed");
      expect(job.error).toContain("unknown claude session");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
