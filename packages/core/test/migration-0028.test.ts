import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { newUlid } from "../src/intent/ids.ts";
import { applyIncremental, ensureTables, rebuildAll } from "../src/intent/projections/index.ts";
import { registerAllProjections } from "../src/intent/projections/register.ts";
import { EventStore } from "../src/intent/store.ts";
import { compareProjectionsToReplay } from "../src/scry/replay.ts";

registerAllProjections();

const HERO = "01HERO0000000000000000000H";

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tempad-migration-0028-"));
  path = join(directory, "tempad.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Builds a database the way release 0.3.x at schema 26 left it: events in the
 * log, every projection populated by a replay of them, and `quests` carrying
 * the shape the projection's `createSql` had before the title-quality columns
 * existed (the two flag columns are dropped, so no flags anywhere).
 */
function buildVersion26Database(): void {
  const old = openDatabase(path, { hostSlug: "host", upToVersion: 26 });
  ensureTables(old);
  const store = new EventStore(old);
  const at = "2026-09-07T09:00:00.000Z";
  const events = [
    store.append({
      actor: "hero",
      kind: "hero.created",
      subject: HERO,
      payload: { name: "S" },
    }),
    store.append({
      actor: "hero",
      kind: "quest.created",
      subject: newUlid(),
      payload: { owner: { kind: "hero", id: HERO }, title: "fix stuff", outcome: "x" },
      at,
    }),
    store.append({
      actor: "hero",
      kind: "quest.created",
      subject: newUlid(),
      payload: {
        owner: { kind: "hero", id: HERO },
        title: "Ship the sync engine",
        outcome: "x",
      },
      at,
    }),
    store.append({
      actor: "hero",
      kind: "quest.created",
      subject: newUlid(),
      payload: {
        owner: { kind: "hero", id: HERO },
        title: "Ship the sync engine v2", // distinct title; the reword below creates the duplicate
        outcome: "x",
      },
      at,
    }),
    store.append({
      actor: "hero",
      kind: "quest.reworded",
      subject: store.read().at(-1)!.subject,
      payload: { title: "Ship the sync engine" },
      at,
    }),
  ];
  for (const event of events) applyIncremental(old, event);
  // The pre-0028 `quests` shape: the projection's table without the two flag
  // columns a release at 26 did not have.
  old.exec(
    "ALTER TABLE quests DROP COLUMN title_vague; ALTER TABLE quests DROP COLUMN title_vague_reason;",
  );
  old.close();
}

describe("migration 0028 (title_vague)", () => {
  test("upgrading a version-26 database populates the flags by replaying quest events", () => {
    buildVersion26Database();
    const upgraded = openDatabase(path, { hostSlug: "host" });
    expect(upgraded.query("PRAGMA user_version").get() as { user_version: number }).toMatchObject({
      user_version: 28,
    });
    // The migration's replay left every projection exactly equal to a full
    // replay -- the whole-projection guarantee `tempad rebuild` gives.
    expect(compareProjectionsToReplay(upgraded)).toEqual([]);
    const rows = upgraded
      .query(
        "SELECT id, title, title_vague, title_vague_reason FROM quests ORDER BY created_at, id",
      )
      .all() as {
      id: string;
      title: string;
      title_vague: number;
      title_vague_reason: string | null;
    }[];
    expect(rows).toHaveLength(3);
    // The vague title is flagged by the migration replay, not left at the
    // ALTER default 0.
    expect(rows.find((row) => row.title === "fix stuff")).toMatchObject({
      title_vague: 1,
    });
    // The original is unflagged and the later reworded duplicate is flagged
    // with the original's id, exactly as a live declaration would have been.
    const duplicate = rows.find((row) => row.title_vague_reason?.startsWith("duplicate:"));
    const original = rows.find((row) => row.title === "Ship the sync engine" && row !== duplicate);
    expect(original).toMatchObject({ title_vague: 0, title_vague_reason: null });
    expect(duplicate?.title_vague).toBe(1);
    expect(duplicate?.title_vague_reason).toBe(`duplicate:${original?.id}`);
    // A full rebuild after the upgrade changes nothing.
    rebuildAll(upgraded);
    expect(compareProjectionsToReplay(upgraded)).toEqual([]);
    expect(
      upgraded
        .query(
          "SELECT id, title, title_vague, title_vague_reason FROM quests ORDER BY created_at, id",
        )
        .all(),
    ).toEqual(rows);
    upgraded.close();
  });

  test("a fresh empty database still reaches 28 with the w5_runs column present", () => {
    const fresh = openDatabase(path, { hostSlug: "host" });
    expect(fresh.query("PRAGMA user_version").get() as { user_version: number }).toMatchObject({
      user_version: 28,
    });
    expect(fresh.query("SELECT name FROM pragma_table_info('w5_runs')")).toBeDefined();
    const columns = fresh.query("SELECT name FROM pragma_table_info('w5_runs')").all() as Array<{
      name: string;
    }>;
    expect(columns.some((each) => each.name === "vague_nudged")).toBe(true);
    fresh.close();
  });
});
