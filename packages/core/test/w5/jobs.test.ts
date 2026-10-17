import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  holdsClaim,
  isThrottled,
  JOB_LEASE_MINUTES,
  JOB_MAX_ATTEMPTS,
  JOB_MAX_REQUEUE_AGE_HOURS,
  reapStaleJobs,
} from "../../src/w5/jobs";

describe("w5 jobs", () => {
  test("enqueue, throttle, duplicate upgrade, claim, complete", () => {
    const database = openDatabase(":memory:");
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: false,
        now: "2026-09-05T10:00:00.000Z",
        throttleMinutes: 10,
      }).enqueued,
    ).toBe(true);
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: false,
        now: "2026-09-05T10:01:00.000Z",
        throttleMinutes: 10,
      }),
    ).toEqual({ enqueued: false, reason: "duplicate" });
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: true,
        now: "2026-09-05T10:01:00.000Z",
        throttleMinutes: 10,
      }),
    ).toEqual({ enqueued: false, reason: "duplicate" });
    expect((database.query("SELECT forced FROM w5_jobs").get() as { forced: number }).forced).toBe(
      1,
    );
    const job = claimNextJob(database, "2026-09-05T10:02:00.000Z");
    expect(job?.sessionId).toBe("s1");
    expect(claimNextJob(database)).toBeNull();
    completeJob(database, job?.id ?? 0, "2026-09-05T10:01:30.000Z", "2026-09-05T10:02:00.000Z");
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: false,
        now: "2026-09-05T10:05:00.000Z",
        throttleMinutes: 10,
      }),
    ).toEqual({ enqueued: false, reason: "throttled" });
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: true,
        now: "2026-09-05T10:05:00.000Z",
        throttleMinutes: 10,
      }).enqueued,
    ).toBe(true);
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: false,
        now: "2026-09-05T10:13:00.000Z",
        throttleMinutes: 10,
      }).enqueued,
    ).toBe(false);
  });

  test("isThrottled reflects w5_runs.last_run_at directly", () => {
    const database = openDatabase(":memory:");
    expect(isThrottled(database, "s3", "2026-09-05T10:00:00.000Z", 10)).toBe(false);
    enqueueJob(database, {
      sessionId: "s3",
      forced: true,
      now: "2026-09-05T10:00:00.000Z",
      throttleMinutes: 10,
    });
    const job = claimNextJob(database, "2026-09-05T10:00:00.000Z");
    completeJob(database, job?.id ?? 0, null, "2026-09-05T10:00:00.000Z");
    expect(isThrottled(database, "s3", "2026-09-05T10:05:00.000Z", 10)).toBe(true);
    expect(isThrottled(database, "s3", "2026-09-05T10:15:00.000Z", 10)).toBe(false);
  });

  test("completeJob records last_run_at as the actual completion time, not claimed_at", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, {
      sessionId: "s4",
      forced: true,
      now: "2026-09-05T10:00:00.000Z",
      throttleMinutes: 10,
    });
    // Claimed early, but the run takes a while to actually finish.
    const job = claimNextJob(database, "2026-09-05T10:00:00.000Z");
    completeJob(database, job?.id ?? 0, null, "2026-09-05T10:20:00.000Z");

    const run = database.query("SELECT last_run_at FROM w5_runs WHERE session_id = 's4'").get() as {
      last_run_at: string;
    };
    expect(run.last_run_at).toBe("2026-09-05T10:20:00.000Z");
    expect(run.last_run_at).not.toBe("2026-09-05T10:00:00.000Z");

    // Throttle window is measured from the real completion time (10:20), not claimed_at (10:00):
    // 5 minutes after completion is still within a 10-minute throttle.
    expect(isThrottled(database, "s4", "2026-09-05T10:25:00.000Z", 10)).toBe(true);
    // Whereas 5 minutes after claimed_at would have already cleared a 10-min throttle
    // under the old (buggy) behavior — confirming we're using completion time, not claim time.
    expect(isThrottled(database, "s4", "2026-09-05T10:05:00.000Z", 10)).toBe(true);
  });

  test("completeJob and failJob stamp finished_at with finishedAt, completeJob keeps now for last_run_at", () => {
    const database = openDatabase(":memory:");
    for (const sessionId of ["s-done", "s-failed"]) {
      enqueueJob(database, {
        sessionId,
        forced: true,
        now: "2026-09-05T10:00:00.000Z",
        throttleMinutes: 10,
      });
    }
    const done = claimNextJob(database, "2026-09-05T10:00:00.000Z");
    const failed = claimNextJob(database, "2026-09-05T10:00:00.000Z");
    const claim = (job: typeof done) => ({
      claimedAt: job?.claimedAt ?? "",
      attempts: job?.attempts ?? 0,
    });

    expect(
      completeJob(
        database,
        done?.id ?? 0,
        null,
        "2026-09-05T10:00:00.000Z",
        null,
        claim(done),
        "2026-09-05T10:00:42.000Z",
      ),
    ).toBe(true);
    expect(
      failJob(database, failed?.id ?? 0, "boom", claim(failed), "2026-09-05T10:00:09.000Z"),
    ).toBe(true);

    expect(
      database
        .query("SELECT session_id, state, claimed_at, finished_at FROM w5_jobs ORDER BY id")
        .all(),
    ).toEqual([
      {
        session_id: "s-done",
        state: "done",
        claimed_at: "2026-09-05T10:00:00.000Z",
        finished_at: "2026-09-05T10:00:42.000Z",
      },
      {
        session_id: "s-failed",
        state: "failed",
        claimed_at: "2026-09-05T10:00:00.000Z",
        finished_at: "2026-09-05T10:00:09.000Z",
      },
    ]);
    expect(
      database.query("SELECT last_run_at FROM w5_runs WHERE session_id = 's-done'").get(),
    ).toEqual({ last_run_at: "2026-09-05T10:00:00.000Z" });
  });

  test("completeJob defaults now to the current time when omitted", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, {
      sessionId: "s5",
      forced: true,
      now: "2026-09-05T10:00:00.000Z",
      throttleMinutes: 10,
    });
    const job = claimNextJob(database, "2026-09-05T10:00:00.000Z");
    const before = Date.now();
    completeJob(database, job?.id ?? 0, null);
    const after = Date.now();

    const run = database.query("SELECT last_run_at FROM w5_runs WHERE session_id = 's5'").get() as {
      last_run_at: string;
    };
    const recordedMs = Date.parse(run.last_run_at);
    expect(recordedMs).toBeGreaterThanOrEqual(before);
    expect(recordedMs).toBeLessThanOrEqual(after);
  });

  test("enqueueJob stores kind, defaulting to classify, and upgrades kind on duplicate", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, {
      sessionId: "s3",
      forced: false,
      now: "2026-09-06T10:00:00.000Z",
      throttleMinutes: 10,
    });
    expect(
      (database.query("SELECT kind FROM w5_jobs WHERE session_id = 's3'").get() as { kind: string })
        .kind,
    ).toBe("classify");

    enqueueJob(database, {
      sessionId: "s3",
      forced: true,
      kind: "session_end",
      now: "2026-09-06T10:01:00.000Z",
      throttleMinutes: 10,
    });
    const row = database
      .query("SELECT kind, forced FROM w5_jobs WHERE session_id = 's3'")
      .get() as {
      kind: string;
      forced: number;
    };
    expect(row).toEqual({ kind: "session_end", forced: 1 });

    const job = claimNextJob(database, "2026-09-06T10:02:00.000Z");
    expect(job?.kind).toBe("session_end");
  });

  test("enqueueJob never downgrades a queued session_end job back to classify", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, {
      sessionId: "s6",
      forced: true,
      kind: "session_end",
      now: "2026-09-06T10:00:00.000Z",
      throttleMinutes: 10,
    });

    // A Stop racing in behind the SessionEnd must not downgrade the job.
    enqueueJob(database, {
      sessionId: "s6",
      forced: false,
      kind: "classify",
      now: "2026-09-06T10:00:30.000Z",
      throttleMinutes: 10,
    });

    expect(
      (database.query("SELECT kind FROM w5_jobs WHERE session_id = 's6'").get() as { kind: string })
        .kind,
    ).toBe("session_end");
  });

  test("failJob records the error and frees the queue", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, { sessionId: "s2", forced: true, throttleMinutes: 10 });
    const job = claimNextJob(database);
    failJob(database, job?.id ?? 0, "boom");
    expect(
      (database.query("SELECT state, error FROM w5_jobs").get() as { state: string; error: string })
        .state,
    ).toBe("failed");
  });

  test("completeJob stores a session note when one is passed", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, { sessionId: "s1", forced: false, throttleMinutes: 10 });
    const job = claimNextJob(database, "2026-09-05T10:00:00.000Z");
    completeJob(
      database,
      job?.id ?? 0,
      "2026-09-05T10:01:30.000Z",
      "2026-09-05T10:02:00.000Z",
      "still on the walk order bug",
    );

    const run = database
      .query("SELECT session_note FROM w5_runs WHERE session_id = 's1'")
      .get() as {
      session_note: string | null;
    };
    expect(run.session_note).toBe("still on the walk order bug");
  });
});

describe("reapStaleJobs", () => {
  const T0 = "2026-09-05T10:00:00.000Z";
  const minutesAfter = (iso: string, minutes: number) =>
    new Date(Date.parse(iso) + minutes * 60_000).toISOString();

  function claimed(database: ReturnType<typeof openDatabase>, sessionId: string, at = T0) {
    enqueueJob(database, { sessionId, forced: true, now: at, throttleMinutes: 10 });
    const job = claimNextJob(database, at);
    if (!job) throw new Error("expected a job");
    return job;
  }

  function row(database: ReturnType<typeof openDatabase>, id: number) {
    return database
      .query("SELECT state, claimed_at, finished_at, error, attempts FROM w5_jobs WHERE id = ?")
      .get(id) as {
      state: string;
      claimed_at: string | null;
      finished_at: string | null;
      error: string | null;
      attempts: number;
    };
  }

  test("claiming counts an attempt", () => {
    const database = openDatabase(":memory:");
    const job = claimed(database, "s1");
    expect(row(database, job.id).attempts).toBe(1);
  });

  test("requeues a running job once its lease has expired", () => {
    const database = openDatabase(":memory:");
    const job = claimed(database, "s1");

    const result = reapStaleJobs(database, minutesAfter(T0, JOB_LEASE_MINUTES + 1));

    expect(result).toEqual({ requeued: 1, failed: 0 });
    expect(row(database, job.id)).toMatchObject({
      state: "queued",
      claimed_at: null,
      finished_at: null,
      attempts: 1,
    });
    // The next claim is a second attempt on the same row.
    expect(claimNextJob(database, minutesAfter(T0, JOB_LEASE_MINUTES + 2))?.id).toBe(job.id);
    expect(row(database, job.id).attempts).toBe(2);
  });

  test("leaves a job alone until the lease runs out, to the millisecond", () => {
    const database = openDatabase(":memory:");
    const job = claimed(database, "s1");
    const edge = minutesAfter(T0, JOB_LEASE_MINUTES);

    expect(reapStaleJobs(database, new Date(Date.parse(edge) - 1).toISOString())).toEqual({
      requeued: 0,
      failed: 0,
    });
    expect(row(database, job.id).state).toBe("running");
    expect(reapStaleJobs(database, edge)).toEqual({ requeued: 1, failed: 0 });
  });

  test("fails a job that has used its attempts", () => {
    const database = openDatabase(":memory:");
    const job = claimed(database, "s1");
    database.query("UPDATE w5_jobs SET attempts = ? WHERE id = ?").run(JOB_MAX_ATTEMPTS, job.id);
    const now = minutesAfter(T0, JOB_LEASE_MINUTES + 1);

    expect(reapStaleJobs(database, now)).toEqual({ requeued: 0, failed: 1 });
    const reaped = row(database, job.id);
    expect(reaped.state).toBe("failed");
    // The claim time, not the reap time: a reap must not make an old failure recent.
    expect(reaped.finished_at).toBe(T0);
    expect(reaped.error).toContain("lease expired");
    expect(reaped.error).toContain(`${JOB_MAX_ATTEMPTS} attempts`);
  });

  test("fails, rather than requeues, a job requested too long ago to classify live", () => {
    const database = openDatabase(":memory:");
    const job = claimed(database, "s1");
    const now = minutesAfter(T0, JOB_MAX_REQUEUE_AGE_HOURS * 60 + 1);

    expect(reapStaleJobs(database, now)).toEqual({ requeued: 0, failed: 1 });
    expect(row(database, job.id).error).toContain("tempad w5 backfill");
  });

  test("a job requested exactly JOB_MAX_REQUEUE_AGE_HOURS ago is still requeued", () => {
    const database = openDatabase(":memory:");
    const job = claimed(database, "s1");
    const now = minutesAfter(T0, JOB_MAX_REQUEUE_AGE_HOURS * 60);

    expect(reapStaleJobs(database, now)).toEqual({ requeued: 1, failed: 0 });
    expect(row(database, job.id).state).toBe("queued");
    // One millisecond older is over the cap.
    const other = claimed(database, "s2", T0);
    expect(reapStaleJobs(database, new Date(Date.parse(now) + 1).toISOString())).toEqual({
      requeued: 0,
      failed: 1,
    });
    expect(row(database, other.id).state).toBe("failed");
  });

  test("the lease runs from the claim, not from the request", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, { sessionId: "s1", forced: true, now: T0, throttleMinutes: 10 });
    // Requested two hours ago, claimed a minute ago.
    const now = minutesAfter(T0, 120);
    const job = claimNextJob(database, minutesAfter(now, -1));
    if (!job) throw new Error("expected a job");

    expect(reapStaleJobs(database, now)).toEqual({ requeued: 0, failed: 0 });
    expect(row(database, job.id).state).toBe("running");
  });

  test("a failed reap keeps the request time when the job was never claimed", () => {
    const database = openDatabase(":memory:");
    database
      .query(
        "INSERT INTO w5_jobs (session_id, kind, forced, requested_at, state, attempts) VALUES ('s1', 'classify', 1, ?, 'running', ?)",
      )
      .run(T0, JOB_MAX_ATTEMPTS);

    reapStaleJobs(database, minutesAfter(T0, JOB_LEASE_MINUTES + 1));

    expect(
      (database.query("SELECT finished_at FROM w5_jobs").get() as { finished_at: string })
        .finished_at,
    ).toBe(T0);
  });

  test("fails a stale job as superseded when its session already has a queued row", () => {
    const database = openDatabase(":memory:");
    const stale = claimed(database, "s1");
    database.query("UPDATE w5_jobs SET kind = 'session_end' WHERE id = ?").run(stale.id);
    // A hook enqueued again after the runner died: a plain, unforced classify.
    enqueueJob(database, {
      sessionId: "s1",
      forced: false,
      now: minutesAfter(T0, 5),
      throttleMinutes: 0,
    });
    const now = minutesAfter(T0, JOB_LEASE_MINUTES + 1);

    expect(reapStaleJobs(database, now)).toEqual({ requeued: 0, failed: 1 });

    expect(row(database, stale.id).state).toBe("failed");
    expect(row(database, stale.id).error).toContain("superseded");
    const queued = database
      .query("SELECT kind, forced FROM w5_jobs WHERE session_id = 's1' AND state = 'queued'")
      .all();
    // One queued row, carrying the stale job's session_end and forced flag.
    expect(queued).toEqual([{ kind: "session_end", forced: 1 }]);
  });

  test("two stale jobs of one session leave exactly one queued row", () => {
    const database = openDatabase(":memory:");
    const first = claimed(database, "s1");
    const second = claimed(database, "s1", minutesAfter(T0, 1));

    reapStaleJobs(database, minutesAfter(T0, JOB_LEASE_MINUTES + 5));

    const states = [first.id, second.id].map((id) => row(database, id).state).sort();
    expect(states).toEqual(["failed", "queued"]);
    expect(
      (
        database
          .query("SELECT COUNT(*) AS n FROM w5_jobs WHERE session_id = 's1' AND state = 'queued'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  test("does not touch queued, done or failed jobs, and reaps each stale one", () => {
    const database = openDatabase(":memory:");
    const done = claimed(database, "done");
    completeJob(database, done.id, null, T0);
    const failed = claimed(database, "failed");
    failJob(database, failed.id, "boom");
    const stale = claimed(database, "stale");
    const fresh = claimed(database, "fresh", minutesAfter(T0, JOB_LEASE_MINUTES));
    enqueueJob(database, { sessionId: "queued", forced: true, now: T0, throttleMinutes: 10 });
    const now = minutesAfter(T0, JOB_LEASE_MINUTES + 1);

    expect(reapStaleJobs(database, now)).toEqual({ requeued: 1, failed: 0 });
    expect(row(database, done.id).state).toBe("done");
    expect(row(database, failed.id).error).toBe("boom");
    expect(row(database, stale.id).state).toBe("queued");
    expect(row(database, fresh.id).state).toBe("running");
  });

  test("a running job with no claimed_at is reaped like any other", () => {
    const database = openDatabase(":memory:");
    database
      .query(
        "INSERT INTO w5_jobs (session_id, kind, forced, requested_at, state) VALUES ('s1', 'classify', 1, ?, 'running')",
      )
      .run(T0);
    expect(reapStaleJobs(database, minutesAfter(T0, JOB_LEASE_MINUTES + 1))).toEqual({
      requeued: 1,
      failed: 0,
    });
  });
});

describe("job claims", () => {
  const T0 = "2026-09-05T10:00:00.000Z";

  test("a reaped runner's claim stops holding, even when the new claim has the same instant", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, { sessionId: "s1", forced: true, now: T0, throttleMinutes: 10 });
    const first = claimNextJob(database, T0);
    if (!first?.claimedAt) throw new Error("expected a claimed job");
    const oldClaim = { claimedAt: first.claimedAt, attempts: first.attempts };
    expect(holdsClaim(database, first.id, oldClaim)).toBe(true);

    reapStaleJobs(database, new Date(Date.parse(T0) + 31 * 60_000).toISOString());
    expect(holdsClaim(database, first.id, oldClaim)).toBe(false);

    // Claimed again at the very same instant: only the attempt count differs.
    const second = claimNextJob(database, T0);
    expect(second?.claimedAt).toBe(T0);
    expect(holdsClaim(database, first.id, oldClaim)).toBe(false);
    expect(holdsClaim(database, first.id, { claimedAt: T0, attempts: second?.attempts ?? 0 })).toBe(
      true,
    );
  });

  test("completeJob and failJob with a lost claim write nothing", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, { sessionId: "s1", forced: true, now: T0, throttleMinutes: 10 });
    const first = claimNextJob(database, T0);
    if (!first?.claimedAt) throw new Error("expected a claimed job");
    const oldClaim = { claimedAt: first.claimedAt, attempts: first.attempts };
    const later = new Date(Date.parse(T0) + 31 * 60_000).toISOString();
    reapStaleJobs(database, later);
    const second = claimNextJob(database, later);
    if (!second?.claimedAt) throw new Error("expected a second claim");

    expect(completeJob(database, first.id, "2026-09-05T10:05:00.000Z", later, null, oldClaim)).toBe(
      false,
    );
    expect(failJob(database, first.id, "late failure", oldClaim)).toBe(false);

    expect(database.query("SELECT state, error FROM w5_jobs").get()).toEqual({
      state: "running",
      error: null,
    });
    expect(database.query("SELECT COUNT(*) AS n FROM w5_runs").get()).toEqual({ n: 0 });

    // The current holder still finishes it.
    const claim = { claimedAt: second.claimedAt, attempts: second.attempts };
    expect(completeJob(database, second.id, null, later, null, claim)).toBe(true);
    expect((database.query("SELECT state FROM w5_jobs").get() as { state: string }).state).toBe(
      "done",
    );
    // A claim is spent once the job settled.
    expect(failJob(database, second.id, "again", claim)).toBe(false);
  });
});

describe("claimNextJob across connections", () => {
  const T0 = "2026-09-05T10:00:00.000Z";

  test("one connection's claim is not handed out again by another", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-claim-test-"));
    try {
      const path = join(directory, "tempad.db");
      const first = openDatabase(path);
      const second = openDatabase(path);
      enqueueJob(first, { sessionId: "s1", forced: true, now: T0, throttleMinutes: 10 });
      enqueueJob(first, { sessionId: "s2", forced: true, now: T0, throttleMinutes: 10 });

      const a = claimNextJob(first, T0);
      const b = claimNextJob(second, T0);
      expect([a?.sessionId, b?.sessionId]).toEqual(["s1", "s2"]);
      expect(claimNextJob(second, T0)).toBeNull();
      expect(claimNextJob(first, T0)).toBeNull();
      first.close();
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the claim returned is the one the statement wrote", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, { sessionId: "s1", forced: true, now: T0, throttleMinutes: 10 });
    const job = claimNextJob(database, "2026-09-05T10:05:00.000Z");
    expect(job).toMatchObject({ claimedAt: "2026-09-05T10:05:00.000Z", attempts: 1 });
    expect(database.query("SELECT state, claimed_at, attempts FROM w5_jobs").get()).toEqual({
      state: "running",
      claimed_at: "2026-09-05T10:05:00.000Z",
      attempts: 1,
    });
  });

  test("racing processes never claim the same job twice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-claim-race-"));
    try {
      const path = join(directory, "tempad.db");
      const seeding = openDatabase(path);
      const jobs = 150;
      for (let index = 0; index < jobs; index += 1) {
        enqueueJob(seeding, {
          sessionId: `session-${index}`,
          forced: true,
          now: T0,
          throttleMinutes: 10,
        });
      }
      seeding.close();

      // Each racer opens its own connection and claims until the queue is empty,
      // starting together at a shared instant so the claims interleave.
      const script = `
        import { openDatabase } from ${JSON.stringify(join(import.meta.dir, "../../src/db/database"))};
        import { claimNextJob } from ${JSON.stringify(join(import.meta.dir, "../../src/w5/jobs"))};
        const database = openDatabase(${JSON.stringify(path)});
        while (Date.now() < Number(process.argv[1])) {}
        const claimed = [];
        for (;;) {
          const job = claimNextJob(database);
          if (!job) break;
          claimed.push([job.id, job.attempts]);
        }
        console.log(JSON.stringify(claimed));
      `;
      const startAt = String(Date.now() + 1500);
      const racers = Array.from({ length: 4 }, () =>
        Bun.spawn(["bun", "--no-env-file", "-e", script, startAt], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const outputs = await Promise.all(
        racers.map(async (racer) => {
          const [text, exit] = await Promise.all([new Response(racer.stdout).text(), racer.exited]);
          expect(exit).toBe(0);
          return JSON.parse(text.trim()) as [number, number][];
        }),
      );

      const claimed = outputs.flat();
      expect(claimed).toHaveLength(jobs);
      expect(new Set(claimed.map(([id]) => id)).size).toBe(jobs);
      expect(claimed.every(([, attempts]) => attempts === 1)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
