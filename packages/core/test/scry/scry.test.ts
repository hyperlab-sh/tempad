import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { setSyncState } from "../../src/db/sync-state";
import { declareQuest } from "../../src/intent/declarations";
import { EventStore } from "../../src/intent/store";
import { runScryCommand } from "../../src/scry/cli";
import { RECOMMENDATION_ORDER } from "../../src/scry/collect";
import type { Check, ScryReport } from "../../src/scry/types";
import { enableMirrorSync } from "../../src/sync/triggers";
import {
  backfillWindowMinutes,
  planBackfillWindows,
  selectBackfillSessions,
} from "../../src/w5/backfill";
import { RESPONSE_EXCERPT_MARKER } from "../../src/w5/classifier-shared";
import { JOB_LEASE_MINUTES } from "../../src/w5/jobs";
import {
  ago,
  classifyAll,
  DAY,
  HOUR,
  type Home,
  insertFailedJob,
  makeHealthyHome,
  makeHome,
  NOW,
  seedHero,
  seedSession,
  w5Config,
} from "./fixture";

const homes: Home[] = [];
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.TEMPAD_HOME;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.TEMPAD_HOME;
  else process.env.TEMPAD_HOME = savedHome;
  for (const home of homes.splice(0)) {
    home.database.close();
    rmSync(home.directory, { recursive: true, force: true });
  }
});

function track(home: Home): Home {
  homes.push(home);
  return home;
}

function scryJson(home: Home, ...flags: string[]): { code: number; report: ScryReport } {
  return scryJsonAt(home, NOW, ...flags);
}

function scryJsonAt(
  home: Home,
  now: Date,
  ...flags: string[]
): { code: number; report: ScryReport } {
  process.env.TEMPAD_HOME = home.directory;
  const lines: string[] = [];
  const code = runScryCommand(["--json", ...flags], {
    now,
    stdout: (line) => lines.push(line),
  });
  return { code, report: JSON.parse(lines.join("\n")) as ScryReport };
}

function checkOf(report: ScryReport, id: string): Check {
  const found = report.checks.find((entry) => entry.id === id);
  if (!found)
    throw new Error(`no check ${id}; have ${report.checks.map((entry) => entry.id).join(", ")}`);
  return found;
}

const recommendationIds = (report: ScryReport) => report.recommendations.map((entry) => entry.id);

describe("healthy home", () => {
  test("exits 0, every check passes, nothing to backfill, eval offered only on a condition", async () => {
    const home = track(await makeHealthyHome());
    const { code, report } = scryJson(home);

    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    for (const id of [
      "schema",
      "integrity",
      "projections",
      "collectors",
      "w5-queue",
      "w5-coverage",
    ]) {
      expect(checkOf(report, id).status).toBe("ok");
    }
    expect(report.stats?.w5?.sessionsInWindow).toBe(6);
    expect(report.stats?.w5?.sessionsWithTraces).toBe(6);
    expect(report.stats?.w5?.windowsPending).toBe(0);
    expect(report.stats?.w5?.windowsCovered).toBeGreaterThanOrEqual(6);
    expect(recommendationIds(report)).not.toContain("backfill");

    const evaluation = report.recommendations.find((entry) => entry.id === "eval");
    expect(evaluation?.command).toBe("tempad w5 eval --from 2026-10-09 --to 2026-10-16");
    expect(evaluation?.condition).toContain("only after");
    expect(report.notes.join(" ")).toContain("cannot say one is due");
  });

  test("the eval baseline counts sessions with traces in the 7 days it prints, not in the whole window", async () => {
    // Six classified sessions, all 8-13 days old: inside the 15-day health window, outside the eval's 7.
    const home = track(makeHome());
    seedHero(home.database);
    for (let index = 0; index < 6; index += 1) {
      seedSession(home.database, { id: `older-${index}`, endedAt: ago(8 * DAY + index * DAY) });
    }
    await classifyAll(home.database);
    const { report } = scryJson(home);
    expect(report.stats?.w5?.sessionsWithTraces).toBe(6);
    expect(recommendationIds(report)).not.toContain("eval");
    expect(report.notes.join(" ")).toContain(
      "only 0 sessions with traces in the last 7 days (need 5)",
    );
  });

  test("the eval line counts the sessions of its own 7 days, and a shorter --days shortens it", async () => {
    const home = track(await makeHealthyHome()); // six sessions with traces within 12 hours
    seedSession(home.database, { id: "older", endedAt: ago(10 * DAY) });
    await classifyAll(home.database);
    const evaluation = scryJson(home).report.recommendations.find((entry) => entry.id === "eval");
    expect(evaluation?.reason).toContain("last 7 days (6 sessions with traces)");
    const short = scryJson(home, "--days", "3").report.recommendations.find(
      (entry) => entry.id === "eval",
    );
    expect(short?.command).toBe("tempad w5 eval --from 2026-10-13 --to 2026-10-16");
    expect(short?.reason).toContain("last 3 days (6 sessions with traces)");
  });

  test("the text report has Health, Stats and Recommendations sections", async () => {
    const home = track(await makeHealthyHome());
    process.env.TEMPAD_HOME = home.directory;
    const lines: string[] = [];
    expect(runScryCommand([], { now: NOW, stdout: (line) => lines.push(line) })).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Health: healthy");
    expect(text).toContain("\nStats\n");
    expect(text).toContain("\nRecommendations\n");
    expect(text).toMatch(/tempad w5 eval --from \S+ --to \S+/);
  });

  test("a fresh install with no data is healthy and recommends nothing, with a note instead of an eval", () => {
    const home = track(makeHome());
    const { code, report } = scryJson(home);
    expect(code).toBe(0);
    expect(report.recommendations).toEqual([]);
    expect(report.notes.join(" ")).toContain("only 0 sessions with traces");
  });
});

describe("backfill recommendation", () => {
  test("names the exact command and range for unclassified sessions, and exits 0", async () => {
    const home = track(await makeHealthyHome());
    // Two sessions three days old, never classified; one that ended ten minutes ago (a hook is still on it).
    seedSession(home.database, { id: "old-1", endedAt: ago(3 * DAY + HOUR) });
    seedSession(home.database, {
      id: "old-2",
      endedAt: ago(2 * DAY),
      messageTimestamps: [ago(2 * DAY + 2 * HOUR), ago(2 * DAY)],
    });
    seedSession(home.database, { id: "live", endedAt: ago(10 * 60_000) });

    const { code, report } = scryJson(home);
    expect(code).toBe(0);
    const coverage = checkOf(report, "w5-coverage");
    expect(coverage.status).toBe("warn");
    expect(report.stats?.w5).toMatchObject({
      windowsPending: 3,
      pendingSessions: 2,
      windowsInFlight: 1,
      sessionsInWindow: 9,
    });
    const backfill = report.recommendations.find((entry) => entry.id === "backfill");
    // The oldest pending session's end, exactly: the command covers it however late it is run.
    expect(backfill?.command).toBe(`tempad w5 backfill --from ${ago(3 * DAY + HOUR)}`);
    expect(backfill?.reason).toContain("classifier call");
    expect(backfill?.condition).toBeUndefined();
  });

  test("the printed command covers the oldest unclassified session however late it is run", async () => {
    const home = track(await makeHealthyHome());
    // 14 d 23 h 40 m old: a day count would drop it twenty minutes after this report.
    const endedAt = ago(15 * DAY - 20 * 60_000);
    seedSession(home.database, { id: "edge", endedAt });
    seedSession(home.database, { id: "newer", endedAt: ago(DAY) });
    const { report } = scryJson(home);
    expect(report.stats?.w5?.windowsPending).toBe(2);
    const command = report.recommendations.find((entry) => entry.id === "backfill")?.command;
    expect(command).toBe(`tempad w5 backfill --from ${endedAt}`);
    // The bound is an instant, not an age: reports made hours or days later name the same one, so
    // the command pasted at any later time still reaches the session.
    for (const delay of [20 * 60_000, 5 * HOUR, 3 * DAY, 40 * DAY]) {
      const later = scryJsonAt(home, new Date(NOW.getTime() + delay), "--days", "90").report;
      expect(later.recommendations.find((entry) => entry.id === "backfill")?.command).toBe(command);
    }
    // And the plan from that bound holds exactly the windows the report counted.
    const planned = planBackfillWindows(
      home.database,
      selectBackfillSessions(home.database, { cutoff: endedAt }),
      { windowMinutes: backfillWindowMinutes(w5Config) },
    ).filter((window) => !window.covered);
    expect(planned.length).toBe(2);
  });

  test("the bound is the oldest pending session's end, not an older one that would pull in classified work", async () => {
    const home = track(await makeHealthyHome());
    seedSession(home.database, { id: "pending", endedAt: ago(5 * DAY) });
    const { report } = scryJson(home);
    const from = report.recommendations.find((entry) => entry.id === "backfill")?.command;
    expect(from).toBe(`tempad w5 backfill --from ${ago(5 * DAY)}`);
    // Classified healthy-* sessions are newer than that; the plan from it holds one pending window.
    const cutoff = ago(5 * DAY);
    const pending = planBackfillWindows(
      home.database,
      selectBackfillSessions(home.database, { cutoff }),
      { windowMinutes: backfillWindowMinutes(w5Config) },
    ).filter((window) => !window.covered);
    expect(pending.map((window) => window.sessionId)).toEqual(["pending"]);
  });

  test("--days narrows the window, so older unclassified sessions are not recommended", async () => {
    const home = track(await makeHealthyHome());
    seedSession(home.database, { id: "old-1", endedAt: ago(5 * DAY) });
    expect(scryJson(home, "--days", "10").report.stats?.w5?.windowsPending).toBe(1);
    const narrow = scryJson(home, "--days", "2").report;
    expect(narrow.windowDays).toBe(2);
    expect(narrow.stats?.w5?.windowsPending).toBe(0);
    expect(recommendationIds(narrow)).not.toContain("backfill");
  });

  test("[w5] backfill_days sets the default window", async () => {
    const home = track(await makeHealthyHome({ toml: "[w5]\nbackfill_days = 3\n" }));
    seedSession(home.database, { id: "old-1", endedAt: ago(5 * DAY) });
    const { report } = scryJson(home);
    expect(report.windowDays).toBe(3);
    expect(report.stats?.w5?.windowsPending).toBe(0);
  });

  test("a session without any message with text has no window to classify", async () => {
    const home = track(makeHome());
    seedSession(home.database, { id: "empty", endedAt: ago(2 * DAY), messageTimestamps: [] });
    const { report } = scryJson(home);
    expect(report.stats?.w5?.sessionsInWindow).toBe(1);
    expect(report.stats?.w5?.windowsPending).toBe(0);
  });
});

describe("collectors", () => {
  test("a stale or never-run collector warns and recommends syncing just that source; exit stays 0", async () => {
    const home = track(await makeHealthyHome());
    setSyncState(home.database, "monday", ago(3 * DAY));
    home.database.query("DELETE FROM sync_state WHERE source = 'github'").run();

    const { code, report } = scryJson(home);
    expect(code).toBe(0);
    const collectors = checkOf(report, "collectors");
    expect(collectors.status).toBe("warn");
    expect(collectors.details).toEqual(["monday: last sync 3 d ago", "github: never synced"]);
    expect(report.recommendations.find((entry) => entry.id === "collect")?.command).toBe(
      "tempad sync",
    );
  });

  test("one stale source names that source", async () => {
    const home = track(await makeHealthyHome());
    setSyncState(home.database, "github", ago(2 * DAY));
    const { report } = scryJson(home);
    expect(report.recommendations.find((entry) => entry.id === "collect")?.command).toBe(
      "tempad sync github",
    );
  });
});

describe("classification jobs", () => {
  test("groups failures by normalized error, flags stuck jobs and recommends reading the log", async () => {
    const home = track(await makeHealthyHome());
    setSyncState(home.database, "claude", ago(HOUR));
    insertFailedJob(
      home.database,
      "unknown claude session: 11111111-2222-3333-4444-555555555555",
      ago(20 * 60_000),
    );
    insertFailedJob(
      home.database,
      "unknown claude session: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ago(30 * 60_000),
    );
    insertFailedJob(home.database, "claude cli exited with code 1", ago(3 * DAY));
    insertFailedJob(home.database, "ancient failure", ago(30 * DAY));
    home.database
      .query(
        "INSERT INTO w5_jobs (session_id, requested_at, claimed_at, state) VALUES ('s', ?, ?, 'running')",
      )
      .run(ago(5 * HOUR), ago(5 * HOUR));

    const { code, report } = scryJson(home);
    expect(code).toBe(0);
    const queue = checkOf(report, "w5-queue");
    expect(queue.status).toBe("warn");
    expect(queue.summary).toBe("3 failed in the last 7 days, 1 stuck running");
    expect(queue.details[0]).toBe("2 x unknown claude session: <id>");
    expect(queue.details).toContain("1 job claimed over 1 h ago and still running");
    expect(report.stats?.w5).toMatchObject({ jobsFailedLast7Days: 3, jobsStuckRunning: 1 });
    expect(report.recommendations.find((entry) => entry.id === "w5-log")?.command).toBe(
      `tail -n 50 ${home.directory}/logs/w5.log`,
    );
    expect(report.recommendations.find((entry) => entry.id === "w5-unknown-session")?.command).toBe(
      "tempad sync claude",
    );
  });

  test("failures that kept the start of a rejected response still group by their message", async () => {
    const home = track(await makeHealthyHome());
    const message = "classifier result invalid:\nsegments[0].quest: expected an active quest alias";
    for (const [index, raw] of [
      '{"segments": [{"what": "a"',
      '{"segments": [{"what": "b"',
      "no json",
    ].entries()) {
      insertFailedJob(
        home.database,
        `${message}${RESPONSE_EXCERPT_MARKER}${raw}`,
        ago((20 + index) * 60_000),
      );
    }
    insertFailedJob(home.database, "claude cli exited with code 1", ago(3 * DAY));

    const { report } = scryJson(home);
    const queue = checkOf(report, "w5-queue");
    expect(queue.summary).toBe("4 failed in the last 7 days, 0 stuck running");
    expect(queue.details[0]).toBe(
      "3 x classifier result invalid: segments[0].quest: expected an active quest alias",
    );
    expect(queue.details.join("\n")).not.toContain("no json");
  });

  test("unknown-session failures for sessions now in the database do not recommend collecting", async () => {
    const home = track(await makeHealthyHome());
    for (const id of ["healthy-0", "healthy-1"]) {
      insertFailedJob(home.database, `unknown claude session: ${id}`, ago(DAY), id);
    }
    const { report } = scryJson(home);
    expect(recommendationIds(report)).toContain("w5-log");
    expect(recommendationIds(report)).not.toContain("w5-unknown-session");
    expect(checkOf(report, "w5-queue").details.join("\n")).toContain(
      "all 2 `unknown claude session` failures are for sessions that are in the database now",
    );
  });

  test("unknown-session failures for sessions still missing recommend collecting, once per session count", async () => {
    const home = track(await makeHealthyHome());
    insertFailedJob(home.database, "unknown claude session: healthy-0", ago(DAY), "healthy-0");
    insertFailedJob(home.database, "unknown claude session: gone-a", ago(20 * 60_000), "gone-a");
    insertFailedJob(home.database, "unknown claude session: gone-a", ago(2 * DAY), "gone-a");
    insertFailedJob(home.database, "unknown claude session: gone-b", ago(10 * 60_000), "gone-b");
    const { report } = scryJson(home);
    const entry = report.recommendations.find((item) => item.id === "w5-unknown-session");
    expect(entry?.command).toBe("tempad sync claude");
    expect(entry?.reason).toContain("2 sessions named by failed jobs");
  });

  describe("sessions missing for failures before the last claude collection", () => {
    // The collector last ran at ago(HOUR) (makeHome). A failure at or before that instant was
    // followed by a collection that did not find the session, so collecting again cannot help.
    const collectedAt = ago(HOUR);
    const plus = (milliseconds: number) =>
      new Date(Date.parse(collectedAt) + milliseconds).toISOString();

    async function run(failures: [string, string][]) {
      const home = track(await makeHealthyHome());
      for (const [sessionId, requestedAt] of failures) {
        insertFailedJob(
          home.database,
          `unknown claude session: ${sessionId}`,
          requestedAt,
          sessionId,
        );
      }
      return scryJson(home).report;
    }

    test("a failure one millisecond after the collection recommends it", async () => {
      const report = await run([["late", plus(1)]]);
      expect(recommendationIds(report)).toContain("w5-unknown-session");
    });

    test("a failure at the instant of the collection does not (the collector had the session's chance)", async () => {
      const report = await run([["same", collectedAt]]);
      expect(recommendationIds(report)).not.toContain("w5-unknown-session");
      expect(checkOf(report, "w5-queue").details.join("\n")).toContain(
        "1 session named by failed jobs has no transcript found on disk by the last claude collection",
      );
    });

    test("a failure before the collection does not, and says nothing is left to collect", async () => {
      const report = await run([
        ["early-a", plus(-1)],
        ["early-b", ago(3 * DAY)],
      ]);
      expect(recommendationIds(report)).not.toContain("w5-unknown-session");
      const details = checkOf(report, "w5-queue").details.join("\n");
      expect(details).toContain("2 sessions named by failed jobs have no transcript");
      expect(details).toContain("nothing to collect");
      expect(details).not.toContain("are in the database now");
    });

    test("a mix counts only the sessions that failed after the collection", async () => {
      const report = await run([
        ["early", ago(2 * DAY)],
        ["late", plus(60_000)],
        // Failed on both sides of the boundary: the newest failure decides.
        ["both", ago(2 * DAY)],
        ["both", plus(1)],
      ]);
      const entry = report.recommendations.find((item) => item.id === "w5-unknown-session");
      expect(entry?.reason).toContain("2 sessions named by failed jobs");
      expect(checkOf(report, "w5-queue").details.join("\n")).toContain(
        "1 session named by failed jobs has no transcript",
      );
    });
  });

  test("a failure the runner worded as no-transcript-found is not recommended for collecting, even after the last collection", async () => {
    const home = track(await makeHealthyHome());
    insertFailedJob(
      home.database,
      "unknown claude session: gone (no transcript found under CLAUDE_DIRS, or it holds no messages)",
      ago(60_000),
      "gone",
    );
    const { report } = scryJson(home);
    expect(recommendationIds(report)).not.toContain("w5-unknown-session");
    expect(checkOf(report, "w5-queue").details.join("\n")).toContain(
      "1 session named by failed jobs has no transcript found",
    );
  });

  test("an old-style unknown-session failure newer than a runner-worded one still recommends collecting", async () => {
    const home = track(await makeHealthyHome());
    insertFailedJob(
      home.database,
      "unknown claude session: gone (no transcript found under CLAUDE_DIRS, or it holds no messages)",
      ago(2 * DAY),
      "gone",
    );
    insertFailedJob(home.database, "unknown claude session: gone", ago(60_000), "gone");
    const { report } = scryJson(home);
    expect(recommendationIds(report)).toContain("w5-unknown-session");
  });

  test("a job requeued by the reaper is neither failed nor stuck", async () => {
    const home = track(await makeHealthyHome());
    home.database
      .query(
        "INSERT INTO w5_jobs (session_id, requested_at, state, attempts) VALUES ('s', ?, 'queued', 1)",
      )
      .run(ago(5 * HOUR));
    const { report } = scryJson(home);
    expect(checkOf(report, "w5-queue").status).toBe("ok");
    expect(report.stats?.w5).toMatchObject({ jobsFailedLast7Days: 0, jobsStuckRunning: 0 });
    expect(recommendationIds(report)).not.toContain("w5-reap");
  });

  test("a stuck running job recommends `tempad w5 run`, which reaps it", async () => {
    const home = track(await makeHealthyHome());
    home.database
      .query(
        "INSERT INTO w5_jobs (session_id, requested_at, claimed_at, state, attempts) VALUES ('s', ?, ?, 'running', 1)",
      )
      .run(ago(5 * HOUR), ago(5 * HOUR));
    const { report } = scryJson(home);
    const entry = report.recommendations.find((item) => item.id === "w5-reap");
    expect(entry?.command).toBe("tempad w5 run");
    expect(entry?.reason).toContain("1 job claimed over 1 h ago is still running");
  });

  test("a job inside its lease is not called stuck", async () => {
    const home = track(await makeHealthyHome());
    home.database
      .query(
        "INSERT INTO w5_jobs (session_id, requested_at, claimed_at, state, attempts) VALUES ('s', ?, ?, 'running', 1)",
      )
      .run(ago(JOB_LEASE_MINUTES * 60_000), ago(JOB_LEASE_MINUTES * 60_000));
    const { report } = scryJson(home);
    expect(report.stats?.w5).toMatchObject({ jobsStuckRunning: 0 });
  });

  test("a claude collector that never ran has looked for nothing: the missing session is not written off", async () => {
    const home = track(await makeHealthyHome());
    home.database.query("DELETE FROM sync_state WHERE source = 'claude'").run();
    insertFailedJob(home.database, "unknown claude session: gone", ago(3 * DAY), "gone");
    const { report } = scryJson(home);
    // The full collect covers it (and replaces the claude-only command), and no detail claims the transcript is absent.
    expect(recommendationIds(report)).toContain("collect");
    expect(checkOf(report, "w5-queue").details.join("\n")).not.toContain("found on disk");
  });

  test("a recommended full collect replaces the claude-only one", async () => {
    const home = track(await makeHealthyHome());
    setSyncState(home.database, "claude", ago(3 * DAY));
    insertFailedJob(
      home.database,
      "unknown claude session: 11111111-2222-3333-4444-555555555555",
      ago(30 * 60_000),
      "missing-session",
    );
    const ids = recommendationIds(scryJson(home).report);
    expect(ids).toContain("collect");
    expect(ids).not.toContain("w5-unknown-session");
  });

  test("failures older than a week do not count", async () => {
    const home = track(await makeHealthyHome());
    insertFailedJob(home.database, "ancient failure", ago(30 * DAY));
    const { report } = scryJson(home);
    expect(checkOf(report, "w5-queue").status).toBe("ok");
    expect(report.stats?.w5?.jobs.failed).toBe(1);
  });
});

describe("projections", () => {
  test("a deleted projection row fails the check, exits 1 and recommends a rebuild", async () => {
    const home = track(await makeHealthyHome());
    home.database.query("DELETE FROM traces WHERE rowid = (SELECT MIN(rowid) FROM traces)").run();

    const { code, report } = scryJson(home);
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    const projections = checkOf(report, "projections");
    expect(projections.status).toBe("fail");
    expect(projections.details.join("\n")).toMatch(
      /traces: stored 5, replay 6 \(1 missing, 0 extra\)/,
    );
    const rebuild = report.recommendations.find((entry) => entry.id === "rebuild");
    expect(rebuild?.command).toBe("tempad rebuild");
  });

  test("an edited projection row shows as one missing and one extra", async () => {
    const home = track(await makeHealthyHome());
    home.database
      .query("UPDATE traces SET what = 'tampered' WHERE rowid = (SELECT MIN(rowid) FROM traces)")
      .run();
    const { code, report } = scryJson(home);
    expect(code).toBe(1);
    expect(checkOf(report, "projections").details.join("\n")).toContain(
      "traces: stored 6, replay 6 (1 missing, 1 extra)",
    );
  });

  test("a dropped projection table fails the check, even one the replay leaves empty", async () => {
    for (const table of ["w5_windows", "identity_aliases", "traces"]) {
      const home = track(await makeHealthyHome());
      home.database.exec(`DROP TABLE ${table}`);
      const { code, report } = scryJson(home);
      expect(code).toBe(1);
      const projections = checkOf(report, "projections");
      expect(projections.status).toBe("fail");
      expect(projections.details).toContain(`${table}: the table does not exist`);
      expect(report.recommendations.find((entry) => entry.id === "rebuild")?.command).toBe(
        "tempad rebuild",
      );
    }
  });

  test("a dropped column fails the check and names the column", async () => {
    const home = track(await makeHealthyHome());
    home.database.exec("ALTER TABLE traces DROP COLUMN doubt");
    const { code, report } = scryJson(home);
    expect(code).toBe(1);
    expect(checkOf(report, "projections").details.join("\n")).toContain("lacks column(s) doubt");
  });

  describe("at schema 24 (side quests keep the parent on the side quest)", () => {
    async function homeWithSideQuest() {
      const home = track(await makeHealthyHome());
      const store = new EventStore(home.database);
      const common = {
        scope: "session" as const,
        declaredBy: "hero" as const,
        heroId: "H1",
        plan: [],
      };
      const parent = declareQuest(store, home.database, {
        ...common,
        sessionId: "healthy-0",
        newQuest: { title: "Parent", outcome: "ship", commitment: "promised" },
        at: ago(3 * HOUR),
      });
      declareQuest(store, home.database, {
        ...common,
        sessionId: "healthy-0",
        newQuest: {
          title: "Side",
          outcome: "unblock",
          commitment: "exploratory",
          origin: parent.questId,
          trigger: "blocked on a flaky test",
          kind: "blocker",
        },
        at: ago(2 * HOUR),
      });
      return { home, parentId: parent.questId };
    }

    test("a side quest's parent is replayed into quests.deviates_from_quest_id and the check passes", async () => {
      const { home, parentId } = await homeWithSideQuest();
      const stored = home.database
        .query("SELECT deviates_from_quest_id AS parent FROM quests WHERE title = 'Side'")
        .get() as { parent: string };
      expect(stored.parent).toBe(parentId);
      const { code, report } = scryJson(home);
      expect(code).toBe(0);
      const projections = checkOf(report, "projections");
      expect(projections.status).toBe("ok");
      expect(report.stats?.database.schemaVersion).toBe(report.stats?.database.latestSchemaVersion);
      expect(report.stats?.database.schemaVersion).toBeGreaterThanOrEqual(24);
    });

    test("a stored parent that differs from the replay fails the check", async () => {
      const { home } = await homeWithSideQuest();
      home.database.exec("UPDATE quests SET deviates_from_quest_id = NULL WHERE title = 'Side'");
      const { code, report } = scryJson(home);
      expect(code).toBe(1);
      expect(checkOf(report, "projections").status).toBe("fail");
    });

    test("a database without the column fails the check and names it", async () => {
      const { home } = await homeWithSideQuest();
      home.database.exec("ALTER TABLE quests DROP COLUMN deviates_from_quest_id");
      const { code, report } = scryJson(home);
      expect(code).toBe(1);
      expect(checkOf(report, "projections").details.join("\n")).toContain(
        "lacks column(s) deviates_from_quest_id",
      );
    });
  });

  test("an extra column fails the check and names the column", async () => {
    const home = track(await makeHealthyHome());
    home.database.exec("ALTER TABLE traces ADD COLUMN leftover TEXT");
    const { code, report } = scryJson(home);
    expect(code).toBe(1);
    expect(checkOf(report, "projections").details.join("\n")).toContain(
      "has unexpected column(s) leftover",
    );
  });

  test("a stale cursor fails even with --fast, which skips the replay", async () => {
    const home = track(await makeHealthyHome());
    home.database
      .query("UPDATE projection_state SET last_event_id = 1 WHERE name = 'stints'")
      .run();
    const { code, report } = scryJson(home, "--fast");
    expect(code).toBe(1);
    expect(checkOf(report, "projections").details[0]).toContain(
      "behind the newest event: stints (1 !=",
    );
  });

  test("--fast skips quick_check and the replay: a deleted row passes, and the report says it did not look", async () => {
    const home = track(await makeHealthyHome());
    home.database.query("DELETE FROM traces WHERE rowid = (SELECT MIN(rowid) FROM traces)").run();
    const { code, report } = scryJson(home, "--fast");
    expect(code).toBe(0);
    expect(checkOf(report, "integrity").status).toBe("skip");
    expect(checkOf(report, "projections").details).toContain("replay compare skipped by --fast");
  });

  test("a rebuild still pending after a pull is a warning, not a failure", async () => {
    const home = track(await makeHealthyHome());
    home.database.query("INSERT INTO sync_meta (key, value) VALUES ('rebuild_pending', 'x')").run();
    const { code, report } = scryJson(home);
    expect(code).toBe(0);
    expect(checkOf(report, "projections").status).toBe("warn");
  });

  test("events without any projection state fail", () => {
    const home = track(makeHome());
    seedHero(home.database);
    home.database.query("DELETE FROM heroes").run();
    home.database.query("DELETE FROM projection_state").run();
    const { code, report } = scryJson(home);
    expect(code).toBe(1);
    expect(checkOf(report, "projections").details.join("\n")).toContain("no cursor");
  });

  test("projection_state rows for projections that no longer exist are ignored", async () => {
    const home = track(await makeHealthyHome());
    home.database
      .query("INSERT INTO projection_state (name, last_event_id) VALUES ('goals', 6354)")
      .run();
    expect(scryJson(home).code).toBe(0);
  });
});

describe("schema", () => {
  test("a database behind this tempad fails, is not migrated by scry, and recommends the command that migrates", () => {
    const home = track(makeHome());
    home.database.close();
    for (const name of readdirSync(home.directory)) {
      if (name.startsWith("tempad.db")) rmSync(join(home.directory, name), { force: true });
    }
    openDatabase(home.databasePath, { upToVersion: 10 }).close();
    home.database = openDatabase(":memory:");
    const digest = () => createHash("sha256").update(readFileSync(home.databasePath)).digest("hex");
    const before = digest();

    const { code, report } = scryJson(home);
    expect(code).toBe(1);
    expect(checkOf(report, "schema").summary).toContain("version 10");
    expect(report.stats).toBeNull();
    expect(report.recommendations.map((entry) => entry.command)).toEqual(["tempad rebuild"]);
    expect(digest()).toBe(before);
    const reopened = new Database(home.databasePath, { readonly: true });
    expect(
      (reopened.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(10);
    reopened.close();
  });

  test("a database newer than this tempad fails and recommends nothing runnable", () => {
    const home = track(makeHome());
    home.database.exec("PRAGMA user_version = 9999");
    const { code, report } = scryJson(home);
    expect(code).toBe(1);
    expect(checkOf(report, "schema").summary).toContain("upgrade tempad");
    expect(report.recommendations).toEqual([]);
  });

  test("a home with no tempad.db fails and recommends the first sync, creating nothing", () => {
    const home = track(makeHome());
    home.database.close();
    rmSync(home.databasePath, { force: true });
    for (const name of readdirSync(home.directory)) {
      if (name.startsWith("tempad.db")) rmSync(join(home.directory, name), { force: true });
    }
    const { code, report } = scryJson(home);
    expect(code).toBe(1);
    expect(checkOf(report, "database").summary).toContain("does not exist");
    expect(report.recommendations.map((entry) => entry.command)).toEqual(["tempad sync"]);
    expect(readdirSync(home.directory).sort()).toEqual([".env"]);
    home.database = openDatabase(":memory:");
  });
});

describe("read-only", () => {
  test("leaves the database file byte for byte as it was and creates no files", async () => {
    const home = track(
      await makeHealthyHome({ toml: '[sync]\nurl = "libsql://example.invalid"\n' }),
    );
    home.database.close();
    home.database = openDatabase(":memory:");
    const digest = () => createHash("sha256").update(readFileSync(home.databasePath)).digest("hex");
    const entries = () => readdirSync(home.directory).sort();
    const before = { digest: digest(), entries: entries() };

    for (const flags of [[], ["--fast"], ["--days", "3"]]) scryJson(home, ...flags);
    expect({ digest: digest(), entries: entries() }).toEqual(before);

    const reopened = new Database(home.databasePath, { readonly: true });
    expect(
      (reopened.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
    ).toBeGreaterThan(0);
    reopened.close();
  });

  test("works while another connection holds a write transaction open", async () => {
    const home = track(await makeHealthyHome());
    home.database.exec("BEGIN IMMEDIATE");
    home.database.query("INSERT INTO sync_meta (key, value) VALUES ('probe', '1')").run();
    const { code } = scryJson(home);
    home.database.exec("ROLLBACK");
    expect(code).toBe(0);
  });
});

describe("sync", () => {
  test("sync off and never run: no sync check, no sync stats, no HOST_SLUG needed", () => {
    const home = track(makeHome({ hostSlug: null }));
    const { code, report } = scryJson(home);
    expect(code).toBe(0);
    expect(report.stats?.sync).toBeNull();
    expect(report.checks.map((entry) => entry.id)).not.toContain("sync");
    expect(report.stats?.w5?.ownHostOnly).toBe(false);
  });

  test("sync on: a missing HOST_SLUG is the usual configuration error", () => {
    const home = track(
      makeHome({ hostSlug: null, toml: '[sync]\nurl = "libsql://example.invalid"\n' }),
    );
    process.env.TEMPAD_HOME = home.directory;
    const saved = process.env.HOST_SLUG;
    delete process.env.HOST_SLUG;
    try {
      expect(() => runScryCommand(["--json"], { now: NOW, stdout: () => {} })).toThrow(ConfigError);
    } finally {
      if (saved !== undefined) process.env.HOST_SLUG = saved;
    }
  });

  test("sync on and never run: warns and recommends the first sync", () => {
    const home = track(makeHome({ toml: '[sync]\nurl = "libsql://example.invalid"\n' }));
    const { code, report } = scryJson(home);
    expect(code).toBe(0);
    expect(checkOf(report, "sync").status).toBe("warn");
    expect(report.stats?.sync).toMatchObject({ enabled: true, mirrorTriggers: false });
    expect(report.recommendations.map((entry) => entry.command)).toContain("tempad sync");
  });

  test("sync on: only this host's sessions are planned for backfill; sync off plans every host", () => {
    const toml = '[sync]\nurl = "libsql://example.invalid"\n';
    const on = track(makeHome({ toml }));
    seedSession(on.database, { id: "mine", endedAt: ago(2 * DAY) });
    seedSession(on.database, { id: "theirs", endedAt: ago(2 * DAY), hostSlug: "elsewhere" });
    const withSync = scryJson(on).report.stats?.w5;
    expect(withSync).toMatchObject({ ownHostOnly: true, sessionsInWindow: 1, windowsPending: 1 });

    const off = track(makeHome());
    seedSession(off.database, { id: "mine", endedAt: ago(2 * DAY) });
    seedSession(off.database, { id: "theirs", endedAt: ago(2 * DAY), hostSlug: "elsewhere" });
    const withoutSync = scryJson(off).report.stats?.w5;
    expect(withoutSync).toMatchObject({
      ownHostOnly: false,
      sessionsInWindow: 2,
      windowsPending: 2,
    });
  });

  test("unpushed changes and pending markers each get their own recommendation", () => {
    const home = track(makeHome({ toml: '[sync]\nurl = "libsql://example.invalid"\n' }));
    enableMirrorSync(home.database);
    home.database.query("UPDATE events SET sync_dirty = 0").run();
    seedHero(home.database);
    seedSession(home.database, { id: "s", endedAt: ago(HOUR) });

    const dirty = scryJson(home).report;
    expect(dirty.stats?.sync?.dirty.events).toBe(1);
    expect(dirty.stats?.sync?.dirty.mirrors).toBeGreaterThan(0);
    expect(dirty.recommendations.find((entry) => entry.id === "sync-push")?.command).toBe(
      "tempad sync --push",
    );

    home.database.query("UPDATE events SET sync_dirty = 0").run();
    for (const table of ["claude_sessions", "claude_messages"]) {
      home.database.query(`UPDATE ${table} SET sync_dirty = 0`).run();
    }
    home.database
      .query(
        "INSERT INTO sync_meta (key, value) VALUES ('pull_own_pending', 'x'), ('reseed_pending', 'y')",
      )
      .run();
    const pending = scryJson(home).report;
    expect(pending.stats?.sync?.dirty).toEqual({ events: 0, mirrors: 0, tombstones: 0 });
    expect(recommendationIds(pending)).toEqual(
      expect.arrayContaining(["sync-reseed", "sync-pull-own"]),
    );
    expect(recommendationIds(pending)).not.toContain("sync-push");

    const fromStart = pending.recommendations.find((entry) => entry.id === "sync-pull-own");
    expect(fromStart?.reason).toBe(
      "first pull on this database, or after a re-seed: downloads the full history from the server",
    );
    expect(checkOf(pending, "sync").details.join("\n")).toContain("no pull position yet");

    // With a pull position kept, the server holds rows of this host that this database lacks.
    home.database.query("INSERT INTO sync_cursors (stream, seq) VALUES ('events', 5)").run();
    const withCursor = scryJson(home).report;
    expect(withCursor.recommendations.find((entry) => entry.id === "sync-pull-own")?.reason).toBe(
      "fetches this host's own rows back from the server",
    );
    expect(checkOf(withCursor, "sync").details.join("\n")).toContain(
      "a reinstall under the same host name, or a restored backup",
    );

    home.database.query("DELETE FROM sync_cursors").run();
    home.database
      .query("DELETE FROM sync_meta WHERE key IN ('pull_own_pending', 'reseed_pending')")
      .run();
    const clean = scryJson(home).report;
    expect(checkOf(clean, "sync").status).toBe("ok");
    expect(recommendationIds(clean).filter((id) => id.startsWith("sync"))).toEqual([]);
  });

  test("[sync] removed while the triggers remain: warns and points at --forget", () => {
    const home = track(makeHome());
    enableMirrorSync(home.database);
    const { code, report } = scryJson(home);
    expect(code).toBe(0);
    expect(checkOf(report, "sync").status).toBe("warn");
    expect(report.recommendations.find((entry) => entry.id === "sync-forget")?.command).toBe(
      "tempad sync --forget",
    );
  });

  test("a malformed [sync] fails the config check instead of crashing", () => {
    const home = track(makeHome({ toml: '[sync]\nurl = "http://example.com"\n' }));
    const { code, report } = scryJson(home);
    expect(code).toBe(1);
    expect(checkOf(report, "config-sync").status).toBe("fail");
    expect(report.stats).not.toBeNull();
  });
});

describe("config", () => {
  test("an unreadable tempad.toml fails the config check", () => {
    // Not `[w5\nbroken`: Bun 1.3.14's parser accepted that as `{ w5: {} }`. A doubled `=` is
    // malformed whatever the version.
    const home = track(makeHome({ toml: "[w5]\nmodel = = 1\n" }));
    const { code, report } = scryJson(home);
    expect(code).toBe(1);
    expect(checkOf(report, "config").status).toBe("fail");
  });

  test("a legacy [w5] key warns (and does not print to the console)", () => {
    const home = track(makeHome({ toml: "[w5]\nmemory_activities = 4\n" }));
    const { code, report } = scryJson(home);
    expect(code).toBe(0);
    const config = checkOf(report, "config");
    expect(config.status).toBe("warn");
    expect(config.details[0]).toContain("memory_stints");
    expect(config.summary).toBe("1 deprecated setting(s) in tempad.toml");
  });

  test("a [w5] key of the wrong type warns with the key, the expected type and the value", () => {
    const home = track(
      makeHome({ toml: '[w5]\nstint_idle_minutes = "abc"\ninference_fallback = 1\n' }),
    );
    const { code, report } = scryJson(home);
    expect(code).toBe(0);
    const config = checkOf(report, "config");
    expect(config.status).toBe("warn");
    expect(config.summary).toBe("2 setting(s) of the wrong type (default used) in tempad.toml");
    expect(config.details).toEqual([
      'tempad.toml: [w5].stint_idle_minutes must be a number, got "abc" (a string); using the default 45. Fix the value.',
      "tempad.toml: [w5].inference_fallback must be true or false, got 1 (a number); using the default true. Fix the value.",
    ]);
    // the run itself carries on with the defaults
    expect(report.ok).toBe(true);
  });

  test("a wrong type and a legacy key are both counted in the summary", () => {
    const home = track(makeHome({ toml: '[w5]\nmemory_activities = 4\nwatch_turns = "x"\n' }));
    const { report } = scryJson(home);
    expect(checkOf(report, "config").summary).toBe(
      "1 setting(s) of the wrong type (default used), 1 deprecated setting(s) in tempad.toml",
    );
  });

  test("a clean tempad.toml still reads cleanly", () => {
    const home = track(makeHome({ toml: "[w5]\nstint_idle_minutes = 30\n" }));
    const { report } = scryJson(home);
    expect(checkOf(report, "config").status).toBe("ok");
  });
});

describe("needs a human", () => {
  test("counts what `tempad review` would list: expired questions, unconfirmed quests, doubted traces", () => {
    const home = track(makeHome());
    seedHero(home.database);
    const store = new EventStore(home.database);
    const declared = declareQuest(store, home.database, {
      sessionId: "declared-session",
      newQuest: { title: "Ship scry", outcome: "done", commitment: "promised" },
      plan: [],
      scope: "session",
      declaredBy: "hero",
      at: ago(2 * HOUR),
      heroId: "H1",
    });
    expect(declared.created).toBe(true);
    const insertQuestion = (id: string, kind: string, state: string, sessionId: string) =>
      home.database
        .query(
          "INSERT INTO questions (id, trace_id, session_id, text, kind, state) VALUES (?, 't', ?, 'q', ?, ?)",
        )
        .run(id, sessionId, kind, state);
    insertQuestion("Q1", "belongs", "expired", "declared-session");
    insertQuestion("Q2", "declare", "expired", "declared-session"); // hidden: the session did declare
    insertQuestion("Q3", "declare", "expired", "never-declared"); // listed
    insertQuestion("Q4", "belongs", "watching", "declared-session"); // not expired yet
    home.database.query("UPDATE quests SET confirmed = 0 WHERE id = ?").run(declared.questId);

    const { report } = scryJson(home, "--fast");
    expect(report.stats?.questions.expiredUnanswered).toBe(2);
    expect(report.stats?.quests.unconfirmed).toBe(1);
    expect(checkOf(report, "attention").summary).toBe(
      "2 expired questions, 1 unconfirmed quest, 0 doubted traces in the last 7 days",
    );
    expect(report.recommendations.find((entry) => entry.id === "review")?.command).toBe(
      "tempad review",
    );
  });
});

describe("report shape", () => {
  test("--json has a stable top-level and per-entry shape", async () => {
    const home = track(
      await makeHealthyHome({ toml: '[sync]\nurl = "libsql://example.invalid"\n' }),
    );
    const { report } = scryJson(home);
    expect(Object.keys(report).sort()).toEqual(
      [
        "checks",
        "durationMs",
        "generatedAt",
        "home",
        "notes",
        "ok",
        "recommendations",
        "stats",
        "windowDays",
      ].sort(),
    );
    for (const entry of report.checks) {
      expect(Object.keys(entry).sort()).toEqual(["details", "id", "status", "summary", "title"]);
      expect(["ok", "warn", "fail", "skip"]).toContain(entry.status);
    }
    for (const entry of report.recommendations) {
      expect(typeof entry.command).toBe("string");
      expect(entry.command).toMatch(/^(tempad |tail )/);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    expect(Object.keys(report.stats ?? {}).sort()).toEqual(
      [
        "collectors",
        "database",
        "events",
        "questions",
        "quests",
        "sources",
        "stints",
        "sync",
        "traces",
        "w5",
      ].sort(),
    );
    expect(report.stats?.database.schemaVersion).toBe(report.stats?.database.latestSchemaVersion);
    expect(report.generatedAt).toBe(NOW.toISOString());
  });

  test("--json stats have a pinned shape, key by key", async () => {
    const home = track(
      await makeHealthyHome({ toml: '[sync]\nurl = "libsql://example.invalid"\n' }),
    );
    const stats = scryJson(home).report.stats;
    const keys = (value: unknown) => Object.keys(value as object).sort();
    expect(typeof stats?.events).toBe("number");
    expect(keys(stats?.database)).toEqual(
      ["latestSchemaVersion", "path", "schemaVersion", "sizeBytes"].sort(),
    );
    expect(keys(stats?.sources)).toEqual(
      [
        "claudeMessages",
        "claudeSessions",
        "githubCommits",
        "githubPullRequests",
        "mondayItems",
      ].sort(),
    );
    for (const source of Object.values(stats?.sources ?? {})) {
      expect(keys(source)).toEqual(["newest", "rows"]);
    }
    expect(keys(stats?.collectors[0])).toEqual(["ageHours", "lastSyncAt", "source"]);
    expect(keys(stats?.quests)).toEqual(["byState", "unconfirmed"]);
    expect(keys(stats?.stints)).toEqual(["closed", "dismissed", "open", "withoutQuestInWindow"]);
    expect(keys(stats?.traces)).toEqual(["doubtedLast7Days", "inWindow"]);
    expect(keys(stats?.questions)).toEqual(["byState", "expiredUnanswered"]);
    expect(keys(stats?.w5)).toEqual(
      [
        "jobs",
        "jobsFailedLast7Days",
        "jobsStuckRunning",
        "oldestPendingSessionEndedAt",
        "ownHostOnly",
        "pendingSessions",
        "sessionsDeclared",
        "sessionsInWindow",
        "sessionsUndeclared",
        "sessionsWithTraces",
        "windowDays",
        "windowsCovered",
        "windowsInFlight",
        "windowsPending",
      ].sort(),
    );
    expect(keys(stats?.w5?.jobs)).toEqual(["done", "failed", "queued", "running"]);
    expect(keys(stats?.sync)).toEqual(
      [
        "dirty",
        "enabled",
        "forgottenServers",
        "lastPushedStamp",
        "mirrorTriggers",
        "pending",
        "serverKnown",
      ].sort(),
    );
    expect(keys(stats?.sync?.dirty)).toEqual(["events", "mirrors", "tombstones"]);
    expect(keys(stats?.sync?.pending)).toEqual(["pullOwn", "rebuild", "reseed"]);
    expect(stats?.stints.open).toBeGreaterThan(-1);
    expect(stats?.traces.inWindow).toBe(6);
    expect(stats?.quests.byState).toEqual({});
    expect(JSON.stringify(stats)).not.toContain('"intent"');
  });

  test("with a stale clock the whole run still finishes quickly on a small database", async () => {
    const home = track(await makeHealthyHome());
    expect(scryJson(home).report.durationMs).toBeLessThan(2000);
  });

  test("usage errors exit 2 and write nothing to stdout", () => {
    const home = track(makeHome());
    process.env.TEMPAD_HOME = home.directory;
    for (const args of [
      ["--bogus"],
      ["--days"],
      ["--days", "0"],
      ["--days", "abc"],
      ["--days", "-3"],
      ["--days", "3651"],
      ["--days", "99999999999"],
      ["--days", "1e3"],
      ["extra"],
    ]) {
      const out: string[] = [];
      const err: string[] = [];
      expect(
        runScryCommand(args, {
          stdout: (line) => out.push(line),
          stderr: (line) => err.push(line),
        }),
      ).toBe(2);
      expect(out).toEqual([]);
      expect(err.join("\n")).toContain("usage: tempad scry");
    }
  });
});

describe("--days range and database errors", () => {
  test("3650 is the longest range and still produces a report", async () => {
    const home = track(await makeHealthyHome());
    const { code, report } = scryJson(home, "--days", "3650");
    expect(code).toBe(0);
    expect(report.windowDays).toBe(3650);
  });

  test("a file that is not a database is a failed database check, exit 1", () => {
    const home = track(makeHome());
    home.database.close();
    writeFileSync(home.databasePath, "this is not a sqlite database".repeat(100));
    const { code, report } = scryJson(home);
    expect(code).toBe(1);
    expect(checkOf(report, "database").status).toBe("fail");
    expect(checkOf(report, "database").summary).toContain("cannot read");
    // The afterEach closes the handle again; reopen a throwaway one so that stays valid.
    home.database = new Database(":memory:");
  });

  test("a bug inside scry is not reported as an unreadable database", () => {
    const home = track(makeHome());
    process.env.TEMPAD_HOME = home.directory;
    const original = Database.prototype.query;
    Database.prototype.query = () => {
      throw new TypeError("boom: not a sqlite failure");
    };
    try {
      expect(() => runScryCommand(["--json"], { now: NOW, stdout: () => {} })).toThrow(
        "boom: not a sqlite failure",
      );
    } finally {
      Database.prototype.query = original;
    }
  });
});

describe("recommendation order", () => {
  test("every recommendation id the report can emit has a rank", () => {
    const emitted = new Set<string>();
    for (const file of ["collect.ts", "cli.ts"]) {
      const source = readFileSync(join(import.meta.dir, "../../src/scry", file), "utf8");
      // Recommendations are `id: "<slug>"` object literals; checks use `name`.
      for (const match of source.matchAll(/\bid: "([a-z][a-z-]*)"/g)) {
        emitted.add(match[1] as string);
      }
    }
    // `config` is a check id in cli.ts, not a recommendation.
    emitted.delete("config");

    expect(emitted.size).toBeGreaterThan(10);
    expect([...emitted].filter((id) => !RECOMMENDATION_ORDER.includes(id))).toEqual([]);
  });

  test("reaping stuck jobs ranks before the backfill", () => {
    expect(RECOMMENDATION_ORDER.indexOf("w5-reap")).toBeGreaterThan(-1);
    expect(RECOMMENDATION_ORDER.indexOf("w5-reap")).toBeLessThan(
      RECOMMENDATION_ORDER.indexOf("backfill"),
    );
  });
});
