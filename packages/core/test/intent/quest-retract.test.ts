import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { activeDeclaredQuests } from "../../src/intent/declarations";
import { registerAllProjections } from "../../src/intent/projections/register";
import { runReviewCommand, runW5Command } from "../../src/w5/cli";
import { buildWindow } from "../../src/w5/window";

registerAllProjections();

type Database = ReturnType<typeof openDatabase>;

let errors: string[];
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  errors = [];
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
});

afterEach(() => {
  errorSpy.mockRestore();
});

function harness() {
  const database = openDatabase(":memory:");
  const lines: string[] = [];
  const context = {
    database,
    config: { home: mkdtempSync(join(tmpdir(), "tempad-retract-")), hostSlug: "host" } as Config,
    intentConfig: defaultIntentConfig(),
    stdout: (line: string) => lines.push(line),
  };
  const run = (args: string[]) => runIntentCommand(args, context);
  return { database, lines, context, run };
}

async function addQuest(
  h: ReturnType<typeof harness>,
  title: string,
  extra: string[] = [],
): Promise<string> {
  await h.run(["quest", "add", "--owner", "hero", ...extra, title]);
  return (h.database.query("SELECT id FROM quests WHERE title = ?").get(title) as { id: string })
    .id;
}

function addStint(database: Database, id: string, questId: string, dismissed = false) {
  database
    .query(
      "INSERT INTO stints (id, quest_id, outcome, opened_at, revision, dismissed_at) VALUES (?, ?, 'do work', '2026-09-04T14:00:00.000Z', 1, ?)",
    )
    .run(id, questId, dismissed ? "2026-09-04T14:10:00.000Z" : null);
}

function addTrace(database: Database, id: string, stintId: string) {
  database
    .query(
      `INSERT INTO traces (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES (?, ?, 'claude-code', 'personal/p', 'session', '2026-09-04T14:00:00.000Z', '2026-09-04T14:30:00.000Z', 'hero', 'work', 'ship', 'personal/p', 'claude-code', 0.9, 'assistant', 's1', '2026-09-04T14:30:00.000Z')`,
    )
    .run(id, stintId);
}

function retractedAt(database: Database, table: string, id: string): string | null {
  return (
    database.query(`SELECT retracted_at FROM ${table} WHERE id = ?`).get(id) as {
      retracted_at: string | null;
    }
  ).retracted_at;
}

function retractedEvents(database: Database) {
  return database
    .query("SELECT actor, subject, payload FROM events WHERE kind = 'retracted' ORDER BY uid")
    .all() as { actor: string; subject: string; payload: string }[];
}

async function setup() {
  const h = harness();
  await h.run(["hero", "init", "S"]);
  return h;
}

describe("quest retract", () => {
  test("retracts a quest with no dependents through an event, hiding it from the projection", async () => {
    const h = await setup();
    const id = await addQuest(h, "Mistake");

    expect(await h.run(["quest", "retract", id, "--reason", "typo in the declare"])).toBe(0);

    expect(retractedAt(h.database, "quests", id)).not.toBeNull();
    const events = retractedEvents(h.database);
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("hero");
    expect(events[0]?.subject).toBe(id);
    expect(JSON.parse(events[0]?.payload ?? "{}")).toEqual({
      retracts: id,
      reason: "typo in the declare",
    });
    expect(h.lines.join("\n")).toContain(`retracted quest ${id}`);
  });

  test("a rebuild keeps it retracted (the event, not the row, is the truth)", async () => {
    const h = await setup();
    const id = await addQuest(h, "Mistake");
    await h.run(["quest", "retract", id, "--reason", "oops"]);
    expect(await h.run(["rebuild"])).toBe(0);
    expect(retractedAt(h.database, "quests", id)).not.toBeNull();
  });

  test("`quest delete` is an alias", async () => {
    const h = await setup();
    const id = await addQuest(h, "Mistake");
    expect(await h.run(["quest", "delete", id, "--reason", "oops"])).toBe(0);
    expect(retractedAt(h.database, "quests", id)).not.toBeNull();
  });

  test("the reason is required, and a blank one does not count", async () => {
    const h = await setup();
    const id = await addQuest(h, "Mistake");
    expect(await h.run(["quest", "retract", id])).toBe(2);
    expect(await h.run(["quest", "retract", id, "--reason", "   "])).toBe(2);
    expect(await h.run(["quest", "retract", "--reason", "x"])).toBe(2);
    expect(retractedEvents(h.database)).toHaveLength(0);
    expect(errors.join("\n")).toContain("usage: tempad quest retract");
  });

  test("an unknown quest exits 1 and writes nothing", async () => {
    const h = await setup();
    expect(await h.run(["quest", "retract", "nope", "--reason", "x"])).toBe(1);
    expect(errors.join("\n")).toContain("unknown quest nope");
    expect(retractedEvents(h.database)).toHaveLength(0);
  });

  test("retracting twice is a no-op: message, exit 0, no second event", async () => {
    const h = await setup();
    const id = await addQuest(h, "Mistake");
    await h.run(["quest", "retract", id, "--reason", "oops"]);
    h.lines.length = 0;

    expect(await h.run(["quest", "retract", id, "--reason", "again"])).toBe(0);

    expect(h.lines.join("\n")).toContain("already retracted");
    expect(retractedEvents(h.database)).toHaveLength(1);
  });

  test("an already retracted quest is a no-op even with --force", async () => {
    const h = await setup();
    const id = await addQuest(h, "Mistake");
    await h.run(["quest", "retract", id, "--reason", "oops"]);
    expect(await h.run(["quest", "retract", id, "--reason", "again", "--force"])).toBe(0);
    expect(retractedEvents(h.database)).toHaveLength(1);
  });

  describe("dependents", () => {
    test("refuses a quest with a live stint, naming the stint count", async () => {
      const h = await setup();
      const id = await addQuest(h, "Real work");
      addStint(h.database, "A1", id);

      expect(await h.run(["quest", "retract", id, "--reason", "x"])).toBe(1);

      expect(errors.join("\n")).toContain("1 live stints");
      expect(errors.join("\n")).toContain("--force");
      expect(retractedAt(h.database, "quests", id)).toBeNull();
      expect(retractedEvents(h.database)).toHaveLength(0);
    });

    test("refuses a quest whose stint has live traces", async () => {
      const h = await setup();
      const id = await addQuest(h, "Real work");
      addStint(h.database, "A1", id, true);
      addTrace(h.database, "T1", "A1");
      addTrace(h.database, "T2", "A1");

      expect(await h.run(["quest", "retract", id, "--reason", "x"])).toBe(1);
      expect(errors.join("\n")).toContain("2 live traces");
    });

    test("a retracted stint does not block", async () => {
      const h = await setup();
      const id = await addQuest(h, "Was real");
      addStint(h.database, "A1", id);
      addTrace(h.database, "T1", "A1");
      h.database.query("UPDATE traces SET retracted_at = 'x' WHERE id = 'T1'").run();
      h.database.query("UPDATE stints SET retracted_at = 'x' WHERE id = 'A1'").run();

      expect(await h.run(["quest", "retract", id, "--reason", "x"])).toBe(0);
    });

    test("refuses a quest with a side quest branched from one of its stints", async () => {
      const h = await setup();
      const main = await addQuest(h, "Main");
      addStint(h.database, "A1", main);
      h.database.query("UPDATE stints SET retracted_at = 'x' WHERE id = 'A1'").run();
      addStint(h.database, "A2", main);
      h.database.query("UPDATE stints SET retracted_at = 'x' WHERE id = 'A2'").run();
      const side = await addQuest(h, "Side");
      // The side quest hangs off one of main's stints; the stints are retracted
      // here so only the child quest can be the reason for the refusal.
      h.database.query("UPDATE quests SET deviates_from_stint_id = 'A1' WHERE id = ?").run(side);

      expect(await h.run(["quest", "retract", main, "--reason", "x"])).toBe(1);
      expect(errors.join("\n")).toContain(side);
    });

    test("refuses a quest another quest serves, advances or was merged into", async () => {
      const h = await setup();
      const parent = await addQuest(h, "Parent");

      // `advances` has no column: it lives on the quest.created payload.
      expect(
        await h.run([
          "quest",
          "declare",
          "--session",
          "s1",
          "--new",
          "Advancer",
          "--outcome",
          "o",
          "--advances",
          parent,
        ]),
      ).toBe(0);
      const advancer = (
        h.database.query("SELECT id FROM quests WHERE title = 'Advancer'").get() as { id: string }
      ).id;
      expect(await h.run(["quest", "retract", parent, "--reason", "x"])).toBe(1);
      expect(errors.join("\n")).toContain(advancer);

      errors.length = 0;
      const merged = await addQuest(h, "Merged away");
      await h.run(["quest", "merge", merged, "--into", parent]);
      await h.run(["quest", "retract", advancer, "--reason", "x"]);
      expect(await h.run(["quest", "retract", parent, "--reason", "x"])).toBe(1);
      expect(errors.join("\n")).toContain(merged);
    });

    test("refuses a quest that was itself merged into another", async () => {
      const h = await setup();
      const source = await addQuest(h, "Source");
      const target = await addQuest(h, "Target");
      await h.run(["quest", "merge", source, "--into", target]);

      expect(await h.run(["quest", "retract", source, "--reason", "x"])).toBe(1);
      expect(errors.join("\n")).toContain(`merged into ${target}`);
    });

    test("--force retracts the traces, stints and child quests too, not the merge target", async () => {
      const h = await setup();
      const target = await addQuest(h, "Target");
      const parent = await addQuest(h, "Parent");
      addStint(h.database, "A1", parent);
      addStint(h.database, "A2", parent, true);
      addTrace(h.database, "T1", "A1");
      addTrace(h.database, "T2", "A2");
      const side = await addQuest(h, "Side");
      h.database.query("UPDATE quests SET deviates_from_stint_id = 'A1' WHERE id = ?").run(side);
      addStint(h.database, "A3", side);
      addTrace(h.database, "T3", "A3");
      const folded = await addQuest(h, "Folded in");
      await h.run(["quest", "merge", folded, "--into", parent]);
      await h.run(["quest", "merge", parent, "--into", target]);

      expect(await h.run(["quest", "retract", parent, "--reason", "all mistaken", "--force"])).toBe(
        0,
      );

      for (const [table, id] of [
        ["traces", "T1"],
        ["traces", "T2"],
        ["traces", "T3"],
        ["stints", "A1"],
        ["stints", "A2"],
        ["stints", "A3"],
        ["quests", parent],
        ["quests", side],
        ["quests", folded],
      ] as const) {
        expect(retractedAt(h.database, table, id), `${table} ${id}`).not.toBeNull();
      }
      expect(retractedAt(h.database, "quests", target)).toBeNull();
      expect(h.lines.join("\n")).toContain("3 traces, 3 stints, 2 child quests");
      // The reason travels with every cascaded event.
      for (const event of retractedEvents(h.database)) {
        expect(JSON.parse(event.payload).reason).toContain("all mistaken");
      }
    });

    test("the id is taken exactly: a merged-away id retracts itself, never its target", async () => {
      const h = await setup();
      const source = await addQuest(h, "Source");
      const target = await addQuest(h, "Target");
      await h.run(["quest", "merge", source, "--into", target]);

      expect(await h.run(["quest", "retract", source, "--reason", "x", "--force"])).toBe(0);

      expect(retractedAt(h.database, "quests", source)).not.toBeNull();
      expect(retractedAt(h.database, "quests", target)).toBeNull();
    });
  });
});

describe("a retracted quest disappears from every surface", () => {
  async function withRetracted() {
    const h = await setup();
    const kept = await addQuest(h, "Kept");
    const gone = await addQuest(h, "Gone");
    await h.run(["quest", "retract", gone, "--reason", "oops"]);
    h.lines.length = 0;
    errors.length = 0;
    return { ...h, kept, gone };
  }

  test("quest list hides it", async () => {
    const h = await withRetracted();
    await h.run(["quest", "list"]);
    const out = h.lines.join("\n");
    expect(out).toContain("Kept");
    expect(out).not.toContain("Gone");
  });

  test("quest list --all shows it marked (retracted)", async () => {
    const h = await withRetracted();
    await h.run(["quest", "list", "--all"]);
    const gone = h.lines.find((line) => line.includes("Gone"));
    expect(gone).toContain("(retracted)");
    expect(h.lines.find((line) => line.includes("Kept"))).not.toContain("(retracted)");
  });

  test("quest list --unconfirmed and --side hide it", async () => {
    const h = await withRetracted();
    h.database.query("UPDATE quests SET confirmed = 0").run();
    h.database.query("UPDATE quests SET deviates_from_stint_id = 'A1'").run();

    await h.run(["quest", "list", "--unconfirmed"]);
    expect(h.lines.join("\n")).toContain("Kept");
    expect(h.lines.join("\n")).not.toContain("Gone");

    h.lines.length = 0;
    await h.run(["quest", "list", "--side"]);
    expect(h.lines.join("\n")).toContain("Kept");
    expect(h.lines.join("\n")).not.toContain("Gone");
  });

  test("quest list --as-of a date after the retraction hides it", async () => {
    const h = await withRetracted();
    await h.run(["quest", "list", "--as-of", "2999-01-01T00:00:00.000Z"]);
    expect(h.lines.join("\n")).toContain("Kept");
    expect(h.lines.join("\n")).not.toContain("Gone");
  });

  test("confirm, merge (either side), branch, return and lifecycle commands refuse it", async () => {
    const h = await withRetracted();
    const commands: string[][] = [
      ["quest", "confirm", h.gone],
      ["quest", "merge", h.gone, "--into", h.kept],
      ["quest", "merge", h.kept, "--into", h.gone],
      ["quest", "branch", h.gone, "--deviates-from", "A1", "--trigger", "t"],
      ["quest", "return", h.gone, "--to", h.kept],
      ["quest", "return", h.kept, "--to", h.gone],
      ["quest", "pause", h.gone],
      ["quest", "resume", h.gone],
      ["quest", "done", h.gone],
      ["quest", "abandon", h.gone],
    ];
    for (const command of commands) {
      errors.length = 0;
      expect(await h.run(command), command.join(" ")).toBe(1);
      expect(errors.join("\n"), command.join(" ")).toContain(`quest ${h.gone} is retracted`);
    }
    const state = h.database
      .query("SELECT state, merged_into FROM quests WHERE id = ?")
      .get(h.gone) as { state: string; merged_into: string | null };
    expect(state).toEqual({ state: "started", merged_into: null });
  });

  test("reword, replace, edit and end refuse it", async () => {
    const h = await withRetracted();
    const commands: string[][] = [
      ["quest", "reword", h.gone, "New title"],
      ["quest", "replace", h.gone, "New title", "--reason", "r"],
      ["quest", "edit", h.gone, "New title"],
      ["quest", "end", h.gone, "--reason", "r"],
    ];
    for (const command of commands) {
      errors.length = 0;
      expect(await h.run(command), command.join(" ")).toBe(1);
      expect(errors.join("\n"), command.join(" ")).toContain("is retracted");
    }
    const row = h.database.query("SELECT title, ended_at FROM quests WHERE id = ?").get(h.gone) as {
      title: string;
      ended_at: string | null;
    };
    expect(row).toEqual({ title: "Gone", ended_at: null });
  });

  test("a merge chain that ends on a retracted quest is refused as retracted", async () => {
    const h = await setup();
    const source = await addQuest(h, "Source");
    const target = await addQuest(h, "Target");
    await h.run(["quest", "merge", source, "--into", target]);
    await h.run(["quest", "retract", target, "--reason", "x", "--force"]);
    errors.length = 0;

    expect(await h.run(["quest", "confirm", source])).toBe(1);
    expect(errors.join("\n")).toContain(`quest ${target} is retracted`);
  });

  test("declare --quest and declare --done refuse it", async () => {
    const h = await withRetracted();
    expect(await h.run(["quest", "declare", "--session", "s1", "--quest", h.gone])).toBe(1);
    expect(errors.join("\n")).toContain("is retracted");
    errors.length = 0;
    expect(await h.run(["quest", "declare", "--session", "s1", "--done", h.gone])).toBe(1);
    expect(errors.join("\n")).toContain("is retracted");
  });

  test("answer --quest refuses it and leaves the question open", async () => {
    const h = await withRetracted();
    addStint(h.database, "A1", h.kept);
    addTrace(h.database, "T1", "A1");
    h.database
      .query(
        "INSERT INTO questions (id, trace_id, session_id, text, kind, state, turns_watched) VALUES ('Z1', 'T1', 's1', 'which quest?', 'which_quest', 'asked', 0)",
      )
      .run();

    expect(await h.run(["answer", "Z1", "--quest", h.gone])).toBe(1);

    expect(errors.join("\n")).toContain(`quest ${h.gone} is retracted`);
    expect(
      (h.database.query("SELECT state FROM questions WHERE id = 'Z1'").get() as { state: string })
        .state,
    ).toBe("asked");
    expect(
      (
        h.database.query("SELECT quest_id FROM stints WHERE id = 'A1'").get() as {
          quest_id: string;
        }
      ).quest_id,
    ).toBe(h.kept);
  });

  test("w5 context stops listing it as an active quest of the session", async () => {
    const h = await setup();
    await h.run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Mistaken declare",
      "--outcome",
      "o",
    ]);
    const id = (
      h.database.query("SELECT id FROM quests WHERE title = 'Mistaken declare'").get() as {
        id: string;
      }
    ).id;
    h.lines.length = 0;
    await runW5Command(["context", "--session", "s1"], h.context);
    expect(h.lines.join("\n")).toContain("active quests: Mistaken declare [Q1]");

    await h.run(["quest", "retract", id, "--reason", "oops"]);
    h.lines.length = 0;
    await runW5Command(["context", "--session", "s1"], h.context);

    expect(h.lines.join("\n")).toContain("active quests: none");
    expect(h.lines.join("\n")).not.toContain("Mistaken declare");
    expect(activeDeclaredQuests(h.database, { sessionId: "s1", at: "2999-01-01" })).toEqual([]);
  });

  describe("classifier window", () => {
    const memoryInput = { maxMessages: 50, memoryHours: 8, memoryStints: 10, overlapMessages: 3 };

    function seedSession(database: Database) {
      database
        .query(
          `INSERT INTO claude_sessions
            (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
             started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
           VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p', 'main',
                   '2026-09-04T14:00:00.000Z', '2026-09-04T15:20:00.000Z', 1, 0, '[]', 'host', '2026-09-04T15:20:00.000Z')`,
        )
        .run();
      database
        .query(
          "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES ('m1', 's1', '2026-09-04T15:00:00.000Z', 'user', 0, 'hi')",
        )
        .run();
    }

    test("inferred mode offers neither the retracted open quest nor a retracted side quest", async () => {
      const h = await withRetracted();
      seedSession(h.database);
      h.database
        .query(
          "UPDATE quests SET deviates_from_stint_id = 'A0', trigger = 'because', branched_at = '2026-09-04T13:00:00.000Z'",
        )
        .run();

      const window = buildWindow(h.database, {
        sessionId: "s1",
        sinceTs: null,
        mode: "inferred",
        ...memoryInput,
      });

      expect(window.openQuests?.map((quest) => quest.title)).toEqual(["Kept"]);
      expect(window.recentSideQuests?.map((quest) => quest.title)).toEqual(["Kept"]);
    });

    test("declared mode lists no retracted quest as active, and a stint's quest label drops", async () => {
      const h = await setup();
      seedSession(h.database);
      await h.run(["quest", "declare", "--session", "s1", "--new", "Gone", "--outcome", "o"]);
      const id = (
        h.database.query("SELECT id FROM quests WHERE title = 'Gone'").get() as { id: string }
      ).id;
      addStint(h.database, "A1", id);
      addTrace(h.database, "T1", "A1");
      h.database.query("UPDATE stints SET closed_at = '2026-09-04T14:40:00.000Z'").run();
      const before = buildWindow(h.database, { sessionId: "s1", sinceTs: null, ...memoryInput });
      expect(before.activeQuests.map((quest) => quest.title)).toEqual(["Gone"]);
      expect(before.recentStints.map((stint) => stint.questTitle)).toEqual(["Gone"]);

      await h.run(["quest", "retract", id, "--reason", "oops", "--force"]);
      const after = buildWindow(h.database, { sessionId: "s1", sinceTs: null, ...memoryInput });
      expect(after.activeQuests).toEqual([]);
      expect(after.recentStints).toEqual([]);
    });

    test("a live stint left on a retracted quest is offered without the quest label", async () => {
      const h = await setup();
      seedSession(h.database);
      const id = await addQuest(h, "Gone");
      addStint(h.database, "A1", id);
      addTrace(h.database, "T1", "A1");
      h.database.query("UPDATE stints SET closed_at = '2026-09-04T14:40:00.000Z'").run();
      // Retract the quest row only, as the lead did by hand.
      h.database.query("UPDATE quests SET retracted_at = 'x' WHERE id = ?").run(id);

      const window = buildWindow(h.database, { sessionId: "s1", sinceTs: null, ...memoryInput });

      expect(window.recentStints.map((stint) => stint.questTitle)).toEqual([null]);
    });
  });

  test("tempad review does not list it as an unconfirmed quest", async () => {
    const h = await setup();
    const gone = await addQuest(h, "Unconfirmed gone");
    h.database.query("UPDATE quests SET confirmed = 0").run();
    h.lines.length = 0;
    runReviewCommand([], h.context);
    expect(h.lines.join("\n")).toContain("Unconfirmed gone");

    await h.run(["quest", "retract", gone, "--reason", "oops"]);
    h.lines.length = 0;
    runReviewCommand([], h.context);
    expect(h.lines.join("\n")).not.toContain("Unconfirmed gone");
  });

  test("a retracted quest no longer counts as an attachment of its saga or an edit blocker", async () => {
    const h = await setup();
    await h.run(["saga", "add", "--owner", "hero", "Saga"]);
    const saga = (h.database.query("SELECT id FROM sagas").get() as { id: string }).id;
    const quest = await addQuest(h, "Serving", ["--serves", saga]);
    expect(await h.run(["saga", "edit", saga, "Renamed"])).toBe(1);

    await h.run(["quest", "retract", quest, "--reason", "oops"]);
    errors.length = 0;

    expect(await h.run(["saga", "edit", saga, "Renamed"])).toBe(0);
  });
});
