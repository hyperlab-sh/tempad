import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { rawKindsFor } from "../../src/intent/legacy";
import { rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { OLD_EVENTS, OLD_PROJECTION_SQL } from "../fixtures/legacy/old-schema";

registerAllProjections();

function temporaryPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "tempad-legacy-chain-")), name);
}

/**
 * Builds a database the way `main` left one: migrations 0001-0010 applied by
 * hand (so `user_version` is 10), the projection tables created from main's
 * own `createSql`, and old-vocabulary rows in `events`.
 */
function seedPreRenameDatabase(path: string): void {
  // Let the production runner apply exactly 0001-0010 (it knows not to split
  // trigger bodies on their semicolons, and tolerates the ALTERs that target
  // projection tables the intent layer has not created yet), leaving
  // `user_version` at 10, so the assertions below exercise the real 0011
  // onward through `openDatabase`.
  const staging = openDatabase(path, { upToVersion: 10 });

  // The projection tables as `ensureTables` created them on main, already
  // carrying the columns 0006-0010 would have added.
  staging.exec(OLD_PROJECTION_SQL);

  const insert = staging.query(
    `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of OLD_EVENTS) {
    insert.run(
      event.at,
      event.at,
      event.actor,
      event.sessionId,
      event.kind,
      event.subject,
      JSON.stringify(event.payload),
    );
  }
  staging.close();
}

describe("the real 0001-0011 chain over a pre-rename database", () => {
  test("migrates, then rebuilds old-vocabulary events into the renamed projections", () => {
    const path = temporaryPath("chain.db");
    seedPreRenameDatabase(path);

    const database = openDatabase(path);

    expect(
      (database.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(24);
    expect(database.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);

    // The events themselves are untouched: still spelled the old way.
    expect(
      database.query("SELECT count(*) AS n FROM events WHERE kind LIKE 'activity.%'").get(),
    ).toEqual({ n: 3 });
    expect(
      database.query("SELECT count(*) AS n FROM events WHERE kind LIKE 'stint.%'").get(),
    ).toEqual({ n: 0 });

    rebuildAll(database);

    expect(database.query("SELECT count(*) AS n FROM sagas").get()).toEqual({ n: 1 });
    expect(database.query("SELECT count(*) AS n FROM quests").get()).toEqual({ n: 2 });
    expect(database.query("SELECT count(*) AS n FROM stints").get()).toEqual({ n: 2 });
    expect(database.query("SELECT count(*) AS n FROM traces").get()).toEqual({ n: 2 });

    // Renamed columns carry the values their old payload fields held.
    expect(database.query("SELECT title FROM sagas WHERE id = 'G1'").get()).toEqual({
      title: "keep the lights on, cheaply",
    });
    expect(database.query("SELECT serves, outcome FROM quests WHERE id = 'Q1'").get()).toEqual({
      serves: "G1",
      outcome: "sync finishes under a minute",
    });
    expect(database.query("SELECT quest_id, outcome FROM stints WHERE id = 'A1'").get()).toEqual({
      quest_id: "Q1",
      outcome: "read the collector",
    });
    expect(database.query("SELECT stint_id FROM traces WHERE id = 'T1'").get()).toEqual({
      stint_id: "A1",
    });
    expect(
      database.query("SELECT deviates_from_stint_id, trigger FROM quests WHERE id = 'Q2'").get(),
    ).toEqual({ deviates_from_stint_id: "A1", trigger: "noticed duplicates" });

    // A close-time reason still lands, and the dropped judgment column is gone.
    expect(database.query("SELECT close_reason FROM stints WHERE id = 'A2'").get()).toEqual({
      close_reason: "idle",
    });
    const stintColumns = (
      database.query("PRAGMA table_info(stints)").all() as { name: string }[]
    ).map((column) => column.name);
    expect(stintColumns).toContain("outcome");
    expect(stintColumns).not.toContain("aim");
  });

  test("reading by kind finds pre-rename rows", () => {
    const path = temporaryPath("kinds.db");
    seedPreRenameDatabase(path);
    const database = openDatabase(path);
    const store = new EventStore(database);

    // The regression: `kind` is a decoded name, but the column holds
    // `activity.opened`. Filtering the raw column would return nothing.
    const opened = store.read({ kind: "stint.opened" });
    expect(opened).toHaveLength(2);
    expect(opened.every((event) => event.kind === "stint.opened")).toBe(true);
    expect(opened.map((event) => event.subject)).toEqual(["A1", "A2"]);
    expect(opened[0]?.payload.outcome).toBe("read the collector");

    expect(store.read({ kind: "saga.created" })).toHaveLength(1);
    expect(store.read({ kind: "stint.closed" })).toHaveLength(1);

    // Kinds that were never renamed still work, and unrelated kinds stay out.
    expect(store.read({ kind: "trace.recorded" })).toHaveLength(2);
    expect(store.read({ kind: "quest.declared" })).toHaveLength(0);
  });

  test("rawKindsFor expands a renamed kind and passes others through", () => {
    expect(rawKindsFor("stint.opened").sort()).toEqual(["activity.opened", "stint.opened"]);
    expect(rawKindsFor("saga.ended").sort()).toEqual(["goal.ended", "saga.ended"]);
    expect(rawKindsFor("trace.recorded")).toEqual(["trace.recorded"]);
  });
});
