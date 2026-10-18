import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import type { EventRecord } from "../src/intent/events.ts";
import { applyIncremental, ensureTables, rebuildAll } from "../src/intent/projections/index.ts";
import { questProjection } from "../src/intent/projections/quest.ts";
import { registerAllProjections } from "../src/intent/projections/register.ts";
import { EventStore } from "../src/intent/store.ts";
import { appendLegacyDeclaredSideQuest } from "./fixtures/legacy-side-quest.ts";

registerAllProjections();

const HERO = "01HERO0000000000000000000H";

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tempad-migration-0024-"));
  path = join(directory, "tempad.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/**
 * What the `quest.branched` case did before 0024, copied from that release: it
 * wrote whatever `deviates_from` held onto the subject, so the inverted
 * declare event landed on the parent and a `deviates_from_quest` event stored
 * the string "undefined".
 */
function applyAsVersion23(database: Database, event: EventRecord): void {
  if (event.kind !== "quest.branched") {
    questProjection.apply(database, event);
    return;
  }
  const payload = event.payload;
  database
    .query(
      "UPDATE quests SET deviates_from_stint_id = ?, branched_at = ?, trigger = ?, branch_kind = ? WHERE id = ?",
    )
    .run(
      String(payload.deviates_from),
      String(payload.at ?? event.at),
      String(payload.trigger),
      String(payload.kind),
      event.subject,
    );
}

/** A database at version 23 whose `quests` table was projected by the old reducer. */
function version23(seed: (store: EventStore) => void): void {
  const database = openDatabase(path, { upToVersion: 23 });
  ensureTables(database);
  // The column 0024 adds did not exist yet.
  database.exec("ALTER TABLE quests DROP COLUMN deviates_from_quest_id");
  const store = new EventStore(database);
  seed(store);
  database.exec("DELETE FROM quests");
  for (const event of store.read()) applyAsVersion23(database, event);
  database.close();
}

function createQuest(store: EventStore, id: string, title: string, at: string): void {
  store.append({
    actor: "hero",
    kind: "quest.created",
    subject: id,
    at,
    payload: { owner: { kind: "hero", id: HERO }, title, confirmed: true },
  });
}

interface Relation {
  stint: string | null;
  quest: string | null;
  branchedAt: string | null;
}

function relation(database: Database, id: string): Relation | null {
  return database
    .query(
      `SELECT deviates_from_stint_id AS stint, deviates_from_quest_id AS quest, branched_at AS branchedAt
         FROM quests WHERE id = ?`,
    )
    .get(id) as Relation | null;
}

/** The relation as version 23 stored it, before the quest column existed. */
function relationAtVersion23(database: Database, id: string): Omit<Relation, "quest"> | null {
  return database
    .query(
      "SELECT deviates_from_stint_id AS stint, branched_at AS branchedAt FROM quests WHERE id = ?",
    )
    .get(id) as Omit<Relation, "quest"> | null;
}

function quests(database: Database): unknown[] {
  return database.query("SELECT * FROM quests ORDER BY id").all();
}

function userVersion(database: Database): number {
  return (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

describe("migration 0024_side_quest_parent", () => {
  test("re-projects legacy inverted declarations onto the side quest with no manual rebuild", () => {
    let side = "";
    let leaf = "";
    version23((store) => {
      createQuest(store, "01PARENT000000000000000000", "Parent", "2026-09-01T08:00:00.000Z");
      createQuest(store, "01ROOT0000000000000000000R", "Root", "2026-09-01T07:00:00.000Z");
      // Parent is itself a real side quest of Root, recorded the stint-less way
      // an older hand-run `quest branch` wrote a quest id.
      store.append({
        actor: "hero",
        kind: "quest.branched",
        subject: "01PARENT000000000000000000",
        at: "2026-09-01T08:30:00.000Z",
        payload: { deviates_from: "01ROOT0000000000000000000R", trigger: "t", kind: "blocker" },
      });
      side = appendLegacyDeclaredSideQuest(store, {
        heroId: HERO,
        parentQuestId: "01PARENT000000000000000000",
        title: "Side",
        at: "2026-09-01T10:00:00.000Z",
      });
      leaf = appendLegacyDeclaredSideQuest(store, {
        heroId: HERO,
        parentQuestId: "01PARENT000000000000000000",
        title: "Leaf",
        at: "2026-09-01T11:00:00.000Z",
      });
    });

    // The state an older release left: the relation sits on the parent.
    const before = new Database(path);
    expect(relationAtVersion23(before, "01PARENT000000000000000000")).toMatchObject({
      stint: leaf,
    });
    expect(relationAtVersion23(before, side)).toEqual({ stint: null, branchedAt: null });
    before.close();

    const database = openDatabase(path);
    expect(userVersion(database)).toBe(26);
    expect(relation(database, side)).toEqual({
      stint: null,
      quest: "01PARENT000000000000000000",
      branchedAt: "2026-09-01T10:00:00.000Z",
    });
    expect(relation(database, leaf)).toEqual({
      stint: null,
      quest: "01PARENT000000000000000000",
      branchedAt: "2026-09-01T11:00:00.000Z",
    });
    // The parent gets its own relation back instead of the last side quest's id.
    expect(relation(database, "01PARENT000000000000000000")).toEqual({
      stint: null,
      quest: "01ROOT0000000000000000000R",
      branchedAt: "2026-09-01T08:30:00.000Z",
    });
    expect(relation(database, "01ROOT0000000000000000000R")).toEqual({
      stint: null,
      quest: null,
      branchedAt: null,
    });

    // Exactly what a full rebuild produces, and the stamp matches it.
    const migrated = quests(database);
    const lastEventId = (database.query("SELECT MAX(id) AS id FROM events").get() as { id: number })
      .id;
    expect(
      database.query("SELECT last_event_id FROM projection_state WHERE name = 'quests'").get(),
    ).toEqual({ last_event_id: lastEventId });
    rebuildAll(database);
    expect(quests(database)).toEqual(migrated);
    database.close();
  });

  test("cleans the 'undefined' stint an older reducer stored for a pulled new-shape event", () => {
    version23((store) => {
      createQuest(store, "01PARENT000000000000000000", "Parent", "2026-09-01T08:00:00.000Z");
      createQuest(store, "01SIDE0000000000000000000S", "Side", "2026-09-01T09:00:00.000Z");
      // Written by an upgraded host and pulled by this one before it upgraded.
      store.append({
        actor: "hero",
        kind: "quest.branched",
        subject: "01SIDE0000000000000000000S",
        at: "2026-09-01T09:00:00.000Z",
        payload: {
          deviates_from_quest: "01PARENT000000000000000000",
          trigger: "t",
          kind: "curiosity",
        },
      });
    });
    const before = new Database(path);
    expect(relationAtVersion23(before, "01SIDE0000000000000000000S")).toMatchObject({
      stint: "undefined",
    });
    before.close();

    const database = openDatabase(path);
    expect(relation(database, "01SIDE0000000000000000000S")).toEqual({
      stint: null,
      quest: "01PARENT000000000000000000",
      branchedAt: "2026-09-01T09:00:00.000Z",
    });
    expect(
      database
        .query("SELECT COUNT(*) AS n FROM quests WHERE deviates_from_stint_id = 'undefined'")
        .get(),
    ).toEqual({ n: 0 });
    database.close();
  });

  test("leaves every other projection alone and later incremental events apply once", () => {
    version23((store) => {
      createQuest(store, "01PARENT000000000000000000", "Parent", "2026-09-01T08:00:00.000Z");
      store.append({
        actor: "hook",
        kind: "stint.opened",
        subject: "01STINT000000000000000000S",
        at: "2026-09-01T08:10:00.000Z",
        payload: { quest: "01PARENT000000000000000000", outcome: "work" },
      });
    });
    const seeded = openDatabase(path, { upToVersion: 23 });
    // A stint row the event log does not explain survives: only quests is replayed.
    seeded
      .query(
        "INSERT INTO stints (id, quest_id, outcome, opened_at, revision) VALUES ('HAND', NULL, 'by hand', '2026-09-01T00:00:00.000Z', 1)",
      )
      .run();
    const stintsBefore = seeded.query("SELECT * FROM stints ORDER BY id").all();
    seeded.close();

    const database = openDatabase(path);
    expect(database.query("SELECT * FROM stints ORDER BY id").all()).toEqual(stintsBefore);

    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "quest.reworded",
        subject: "01PARENT000000000000000000",
        payload: { title: "Parent, renamed" },
      }),
    );
    expect(
      database
        .query("SELECT title, revision FROM quests WHERE id = '01PARENT000000000000000000'")
        .get(),
    ).toEqual({ title: "Parent, renamed", revision: 2 });
    database.close();

    // Reopening does not replay again: the version stops it.
    const reopened = openDatabase(path);
    expect(
      reopened
        .query("SELECT title, revision FROM quests WHERE id = '01PARENT000000000000000000'")
        .get(),
    ).toEqual({ title: "Parent, renamed", revision: 2 });
    reopened.close();
  });

  test("a database whose intent layer was never used migrates without creating quests", () => {
    openDatabase(path, { upToVersion: 23 }).close();
    const database = openDatabase(path);
    expect(userVersion(database)).toBe(26);
    expect(
      database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quests'").get(),
    ).toBeNull();
    database.close();
  });
});
