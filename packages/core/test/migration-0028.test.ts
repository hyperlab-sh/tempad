import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { newUlid } from "../src/intent/ids.ts";
import { rebuildAll } from "../src/intent/projections/index.ts";
import { registerAllProjections } from "../src/intent/projections/register.ts";
import { EventStore } from "../src/intent/store.ts";

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
 * log, `quests` rows written by the old projection (which had no
 * `title_vague` columns), and no flags anywhere.
 */
function buildVersion26Database(): void {
  const old = openDatabase(path, { hostSlug: "host", upToVersion: 26 });
  // The `quests` table a release at 26 owned: created by the projection's
  // `createSql`, which had no title-quality columns yet.
  old.exec(`
    CREATE TABLE IF NOT EXISTS quests (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      serves TEXT,
      title TEXT NOT NULL,
      outcome TEXT,
      done_condition TEXT,
      due TEXT,
      budget_minutes INTEGER,
      commitment TEXT,
      origin_kind TEXT NOT NULL DEFAULT 'inferred',
      confirmed INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'started',
      state_reason TEXT,
      merged_into TEXT,
      deviates_from_stint_id TEXT,
      deviates_from_quest_id TEXT,
      branched_at TEXT,
      trigger TEXT,
      branch_kind TEXT,
      returned_at TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      replaced_by TEXT,
      retracted_at TEXT
    );
  `);
  const store = new EventStore(old);
  const at = "2026-09-07T09:00:00.000Z";
  store.append({
    actor: "hero",
    kind: "hero.created",
    subject: HERO,
    payload: { name: "S" },
  });
  const vague = newUlid();
  store.append({
    actor: "hero",
    kind: "quest.created",
    subject: vague,
    payload: { owner: { kind: "hero", id: HERO }, title: "fix stuff", outcome: "x" },
    at,
  });
  const original = newUlid();
  store.append({
    actor: "hero",
    kind: "quest.created",
    subject: original,
    payload: { owner: { kind: "hero", id: HERO }, title: "Ship the sync engine", outcome: "x" },
    at,
  });
  const duplicate = newUlid();
  store.append({
    actor: "hero",
    kind: "quest.created",
    subject: duplicate,
    payload: {
      owner: { kind: "hero", id: HERO },
      title: "Ship the sync engine v2", // distinct title; the reword below creates the duplicate
      outcome: "x",
    },
    at,
  });
  store.append({
    actor: "hero",
    kind: "quest.reworded",
    subject: duplicate,
    payload: { title: "Ship the sync engine" },
    at,
  });
  // The pre-0028 projection shape: no flag columns existed.
  const insert = old.query(
    "INSERT INTO quests (id, owner_kind, owner_id, title, outcome, origin_kind, revision, state, created_at) VALUES (?, 'hero', ?, ?, ?, 'declared', 1, 'started', ?)",
  );
  insert.run(vague, HERO, "fix stuff", "x", at);
  insert.run(original, HERO, "Ship the sync engine", "x", at);
  insert.run(duplicate, HERO, "Ship the sync engine", "x", at);
  old.close();
}

describe("migration 0028 (title_vague)", () => {
  test("upgrading a version-26 database populates the flags by replaying quest events", () => {
    buildVersion26Database();
    const upgraded = openDatabase(path, { hostSlug: "host" });
    expect(upgraded.query("PRAGMA user_version").get() as { user_version: number }).toMatchObject({
      user_version: 28,
    });
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
    // What the migration wrote equals what a full replay produces.
    const snapshot = rows;
    rebuildAll(upgraded);
    expect(
      upgraded
        .query(
          "SELECT id, title, title_vague, title_vague_reason FROM quests ORDER BY created_at, id",
        )
        .all(),
    ).toEqual(snapshot);
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
