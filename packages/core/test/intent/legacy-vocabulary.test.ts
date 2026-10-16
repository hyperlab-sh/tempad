import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";

registerAllProjections();

function temporaryPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "tempad-legacy-")), name);
}

/** Appends a row straight through SQL, bypassing EventStore's new-name write path. */
function insertRawEvent(
  database: Database,
  kind: string,
  subject: string,
  payload: Record<string, unknown>,
  at = "2026-09-01T10:00:00.000Z",
): void {
  database
    .query(
      `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload)
       VALUES (?, ?, 'hero', NULL, ?, ?, ?)`,
    )
    .run(at, at, kind, subject, JSON.stringify(payload));
}

describe("legacy vocabulary at the read boundary", () => {
  test("old event kinds decode as the current kinds", () => {
    const database = openDatabase(temporaryPath("kinds.db"));
    insertRawEvent(database, "activity.opened", "S1", { quest: "Q1", objective: "old field" });
    insertRawEvent(database, "goal.created", "G1", {
      owner: { kind: "hero", id: "H1" },
      title: "a direction",
    });

    const events = new EventStore(database).read();
    expect(events.map((event) => event.kind)).toEqual(["stint.opened", "saga.created"]);
  });

  test("old payload fields decode under the current names", () => {
    const database = openDatabase(temporaryPath("fields.db"));
    insertRawEvent(database, "activity.opened", "S1", { quest: "Q1", objective: "ship the thing" });
    insertRawEvent(database, "quest.created", "Q2", {
      owner: { kind: "hero", id: "H1" },
      title: "q",
      goal: "G1",
      objective: "an outcome",
    });
    insertRawEvent(database, "quest.branched", "Q1", {
      from_activity: "S9",
      trigger: "t",
      kind: "curiosity",
    });

    const [stint, quest, branched] = new EventStore(database).read();
    expect(stint?.payload.outcome).toBe("ship the thing");
    expect(stint?.payload.objective).toBeUndefined();
    expect(quest?.payload.serves).toBe("G1");
    expect(quest?.payload.outcome).toBe("an outcome");
    expect(branched?.payload.deviates_from).toBe("S9");
  });

  test("an event already written with current names is unchanged", () => {
    const database = openDatabase(temporaryPath("current.db"));
    insertRawEvent(database, "stint.opened", "S1", { quest: "Q1", outcome: "already new" });

    const [event] = new EventStore(database).read();
    expect(event?.kind).toBe("stint.opened");
    expect(event?.payload.outcome).toBe("already new");
  });

  test("a database of old-kind events rebuilds into the renamed projections", () => {
    const database = openDatabase(temporaryPath("rebuild.db"));
    insertRawEvent(database, "goal.created", "G1", {
      owner: { kind: "hero", id: "H1" },
      title: "keep the lights on",
    });
    insertRawEvent(database, "quest.created", "Q1", {
      owner: { kind: "hero", id: "H1" },
      title: "fix the sync",
      goal: "G1",
      objective: "sync finishes under a minute",
    });
    insertRawEvent(database, "activity.opened", "S1", {
      quest: "Q1",
      objective: "read the collector",
    });
    insertRawEvent(database, "trace.recorded", "T1", {
      activity: "S1",
      tool: "git",
      place: "repo",
      source: "github",
      started_at: "2026-09-01T10:00:00.000Z",
      ended_at: "2026-09-01T10:05:00.000Z",
      who: "hero",
      what: "read",
      why: "orientation",
      where: "repo",
      how: "cli",
      confidence: 0.9,
      classified_by: "test",
    });

    rebuildAll(database);

    expect(database.query("SELECT title FROM sagas WHERE id = 'G1'").get()).toEqual({
      title: "keep the lights on",
    });
    expect(database.query("SELECT serves, outcome FROM quests WHERE id = 'Q1'").get()).toEqual({
      serves: "G1",
      outcome: "sync finishes under a minute",
    });
    expect(database.query("SELECT quest_id, outcome FROM stints WHERE id = 'S1'").get()).toEqual({
      quest_id: "Q1",
      outcome: "read the collector",
    });
    expect(database.query("SELECT stint_id FROM traces WHERE id = 'T1'").get()).toEqual({
      stint_id: "S1",
    });
  });
});

describe("migration 0011", () => {
  test("renames tables and columns on a database holding old-name data", () => {
    const path = temporaryPath("old.db");

    // Build a database at version 10: the real migration-created tables from
    // 0001-0010, plus the pre-rename projection tables.
    openDatabase(path, { upToVersion: 10 }).close();
    const old = new Database(path);
    old.exec(`
      CREATE TABLE goals (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE activities (
        id TEXT PRIMARY KEY, quest_id TEXT, objective TEXT NOT NULL, outcome TEXT
      );
      CREATE TABLE traces (id TEXT PRIMARY KEY, activity_id TEXT NOT NULL);
      CREATE TABLE trace_links (trace_id TEXT NOT NULL, activity_id TEXT NOT NULL);
      CREATE TABLE quests (
        id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, origin_activity_id TEXT
      );
    `);
    old.query("INSERT INTO goals VALUES ('G1', 'keep the lights on')").run();
    // The pre-rename `outcome` column held a close-time judgment nothing ever
    // wrote; 0011 drops it and `objective` takes the name.
    old.query("INSERT INTO activities VALUES ('S1', 'Q1', 'read the collector', NULL)").run();
    old.query("INSERT INTO traces VALUES ('T1', 'S1')").run();
    old.query("INSERT INTO trace_links VALUES ('T1', 'S1')").run();
    old.query("INSERT INTO quests VALUES ('Q1', 'G1', 'an outcome', 'S0')").run();
    old.close();

    // Stop before 0024: its step re-projects `quests` from the event log, and
    // this hand-built row has no events behind it.
    const database = openDatabase(path, { upToVersion: 23 });

    expect(
      (database.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBeGreaterThanOrEqual(11);
    expect(database.query("SELECT title FROM sagas WHERE id = 'G1'").get()).toEqual({
      title: "keep the lights on",
    });
    expect(database.query("SELECT outcome FROM stints WHERE id = 'S1'").get()).toEqual({
      outcome: "read the collector",
    });
    // The dropped column is gone, so `outcome` is unambiguous: exactly one
    // column of that name, holding what the stint pursued.
    const stintColumns = (
      database.query("PRAGMA table_info(stints)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(stintColumns.filter((name) => name === "outcome")).toHaveLength(1);
    expect(database.query("SELECT stint_id FROM traces WHERE id = 'T1'").get()).toEqual({
      stint_id: "S1",
    });
    expect(database.query("SELECT stint_id FROM trace_links WHERE trace_id = 'T1'").get()).toEqual({
      stint_id: "S1",
    });
    expect(
      database
        .query("SELECT serves, outcome, deviates_from_stint_id FROM quests WHERE id = 'Q1'")
        .get(),
    ).toEqual({ serves: "G1", outcome: "an outcome", deviates_from_stint_id: "S0" });
  });
});
