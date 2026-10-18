import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { declareQuest } from "../../src/intent/declarations";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables, rebuildAll } from "../../src/intent/projections";
import { EventStore } from "../../src/intent/store";
import { runW5Command } from "../../src/w5/cli";

function makeConfig(home: string): Config {
  return {
    mondayApiToken: "t",
    mondayUser: "u",
    ghUser: "u",
    ghOrgs: [],
    ghIncludePersonal: false,
    ghToken: undefined,
    gitAuthorEmails: [],
    claudeDirs: [],
    hostSlug: "host",
    tz: "UTC",
    since: "2020-01-01",
    syncToken: "unused",
    home,
  };
}

function intentHarness() {
  const database = openDatabase(":memory:");
  const lines: string[] = [];
  const context = {
    database,
    config: {} as never,
    intentConfig: defaultIntentConfig(),
    stdout: (line: string) => lines.push(line),
  };
  return { database, lines, run: (args: string[]) => runIntentCommand(args, context) };
}

function questRow(database: ReturnType<typeof openDatabase>, id: string) {
  return database
    .query("SELECT id, title, title_vague, title_vague_reason FROM quests WHERE id = ?")
    .get(id) as {
    id: string;
    title: string;
    title_vague: number;
    title_vague_reason: string | null;
  } | null;
}

describe("title-quality flags on quests", () => {
  test("declare --new flags a vague title in the projection, never rejects", async () => {
    const { run, lines, database } = intentHarness();
    await run(["hero", "init", "S"]);
    expect(
      await run([
        "quest",
        "declare",
        "--session",
        "s1",
        "--new",
        "fix stuff",
        "--outcome",
        "make it work",
      ]),
    ).toBe(0);
    const row = database.query("SELECT id, title_vague, title_vague_reason FROM quests").get() as {
      id: string;
      title_vague: number;
      title_vague_reason: string | null;
    };
    expect(row.title_vague).toBe(1);
    expect(row.title_vague_reason).toBe("fewer than 3 words");
    // A vague title prints no duplicate line (nothing to point at).
    expect(lines.some((line) => line.includes("a quest with this title exists"))).toBe(false);
  });

  test("declare --new prints the duplicate line and still creates the quest", async () => {
    const { run, lines, database } = intentHarness();
    await run(["hero", "init", "S"]);
    await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Ship the sync engine",
      "--outcome",
      "x",
    ]);
    const first = database.query("SELECT id FROM quests").get() as { id: string };
    expect(
      await run([
        "quest",
        "declare",
        "--session",
        "s2",
        "--new",
        "ship the Sync Engine",
        "--outcome",
        "y",
      ]),
    ).toBe(0);
    const rows = database
      .query("SELECT id, title_vague, title_vague_reason FROM quests ORDER BY created_at")
      .all() as {
      id: string;
      title_vague: number;
      title_vague_reason: string | null;
    }[];
    expect(rows.length).toBe(2);
    expect(rows).toMatchObject([
      { title_vague: 0 },
      { title_vague: 1, title_vague_reason: `duplicate:${first.id}` },
    ]);
    expect(lines).toContain(
      `tempad: a quest with this title exists: ${first.id} "Ship the sync engine"; declare it with --quest ${first.id} or keep this one`,
    );
  });

  test("declare --quest never triggers the detector", async () => {
    const { run, lines, database } = intentHarness();
    await run(["hero", "init", "S"]);
    await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Ship the sync engine",
      "--outcome",
      "x",
    ]);
    lines.length = 0;
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    expect(await run(["quest", "declare", "--session", "s2", "--quest", quest.id])).toBe(0);
    expect(lines.some((line) => line.includes("a quest with this title exists"))).toBe(false);
  });

  test("reword to a specific title clears the flag; a vague reword sets it", async () => {
    const { run, database } = intentHarness();
    await run(["hero", "init", "S"]);
    await run(["quest", "declare", "--session", "s1", "--new", "fix stuff", "--outcome", "x"]);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    expect(questRow(database, quest.id)?.title_vague).toBe(1);
    await run(["quest", "reword", quest.id, "Fix the sync token refresh"]);
    expect(questRow(database, quest.id)).toMatchObject({
      title: "Fix the sync token refresh",
      title_vague: 0,
      title_vague_reason: null,
    });
    await run(["quest", "reword", quest.id, "stuff"]);
    expect(questRow(database, quest.id)).toMatchObject({
      title_vague: 1,
      title_vague_reason: "fewer than 3 words",
    });
  });

  test("a duplicate flag is judged against open quests only", async () => {
    const { run, database } = intentHarness();
    await run(["hero", "init", "S"]);
    await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Ship the sync engine",
      "--outcome",
      "x",
    ]);
    const first = database.query("SELECT id FROM quests").get() as { id: string };
    await run(["quest", "end", first.id, "--reason", "done"]);
    // The duplicate target is ended, so the same title is now merely re-used.
    expect(
      await run([
        "quest",
        "declare",
        "--session",
        "s2",
        "--new",
        "Ship the sync engine",
        "--outcome",
        "y",
      ]),
    ).toBe(0);
    const rows = database
      .query("SELECT title_vague, title_vague_reason FROM quests ORDER BY created_at")
      .all() as {
      title_vague: number;
      title_vague_reason: string | null;
    }[];
    expect(rows[1]).toMatchObject({ title_vague: 0 });
  });

  test("rebuild recomputes the same flags from events alone", async () => {
    const { run, database } = intentHarness();
    await run(["hero", "init", "S"]);
    await run(["quest", "declare", "--session", "s1", "--new", "fix stuff", "--outcome", "x"]);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    const before = questRow(database, quest.id);
    rebuildAll(database);
    expect(questRow(database, quest.id)).toEqual(before);
  });
});

describe("w5 context nudge", () => {
  function seedVague(vagueTitle: string) {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: heroId,
        payload: { name: "S" },
      }),
    );
    declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: vagueTitle, outcome: "o", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });
    return { database };
  }

  function contextLines(database: ReturnType<typeof openDatabase>) {
    const lines: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "tempad-tq-"));
    runW5Command(["context", "--session", "s1"], {
      database,
      config: makeConfig(dir),
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    });
    rmSync(dir, { recursive: true, force: true });
    return lines.join("\n").split("\n");
  }

  test("a vague active quest gets one nudge line, once per session", () => {
    const { database } = seedVague("fix stuff");
    const quest = database.query("SELECT id, title FROM quests").get() as {
      id: string;
      title: string;
    };
    const first = contextLines(database);
    const nudge = `Quest "fix stuff" [Q1] has a vague title; reword it with: tempad quest reword ${quest.id} "<specific outcome>"`;
    expect(first).toContain(nudge);
    // The nudge lands after the declaration line.
    expect(first.indexOf(nudge)).toBeGreaterThan(
      first.findIndex((line) => line.startsWith("tempad: session s1")),
    );
    const second = contextLines(database);
    expect(second).not.toContain(nudge);
    const nudged = database
      .query("SELECT vague_nudged FROM w5_runs WHERE session_id = 's1'")
      .get() as {
      vague_nudged: string;
    };
    expect(JSON.parse(nudged.vague_nudged)).toEqual([quest.id]);
  });

  test("an ok active quest gets no nudge line", () => {
    const { database } = seedVague("Ship the marko-ui port");
    const out = contextLines(database);
    expect(out.some((line) => line.includes("has a vague title"))).toBe(false);
    expect(
      database.query("SELECT COUNT(*) AS n FROM w5_runs WHERE session_id = 's1'").get() as {
        n: number;
      },
    ).toMatchObject({ n: 0 });
  });
});
