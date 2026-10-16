import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { setSyncState } from "../../src/db/sync-state";
import { declareQuest } from "../../src/intent/declarations";
import { EventStore } from "../../src/intent/store";
import { runScryCommand } from "../../src/scry/cli";
import type { Check, ScryReport } from "../../src/scry/types";
import { enableMirrorSync } from "../../src/sync/triggers";
import {
  ago,
  DAY,
  HOUR,
  type Home,
  insertFailedJob,
  makeHealthyHome,
  makeHome,
  NOW,
  seedHero,
  seedSession,
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
  process.env.TEMPAD_HOME = home.directory;
  const lines: string[] = [];
  const code = runScryCommand(["--json", ...flags], {
    now: NOW,
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
    expect(backfill?.command).toBe("tempad w5 backfill --days 4");
    expect(backfill?.reason).toContain("classifier call");
    expect(backfill?.condition).toBeUndefined();
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
      ago(DAY),
    );
    insertFailedJob(
      home.database,
      "unknown claude session: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ago(2 * DAY),
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

  test("a recommended full collect replaces the claude-only one", async () => {
    const home = track(await makeHealthyHome());
    setSyncState(home.database, "claude", ago(3 * DAY));
    insertFailedJob(
      home.database,
      "unknown claude session: 11111111-2222-3333-4444-555555555555",
      ago(DAY),
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
    const home = track(makeHome({ toml: "[w5\nbroken" }));
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
    expect(report.stats?.intent).toMatchObject({
      questionsExpiredUnanswered: 2,
      questsUnconfirmed: 1,
    });
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
      ["collectors", "database", "intent", "sources", "sync", "w5"].sort(),
    );
    expect(report.stats?.database.schemaVersion).toBe(report.stats?.database.latestSchemaVersion);
    expect(report.generatedAt).toBe(NOW.toISOString());
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
