import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { openStint } from "../../src/intent/api";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { activeDeclaredQuests } from "../../src/intent/declarations";
import { resolveQuest } from "../../src/intent/projections/quest";
import { EventStore } from "../../src/intent/store";

function harness() {
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

describe("quests", () => {
  test("add with budget and saga, lifecycle events change state", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["saga", "add", "--owner", "hero", "G"]);
    const saga = database.query("SELECT id FROM sagas").get() as { id: string };
    expect(
      await run([
        "quest",
        "add",
        "--owner",
        "hero",
        "--serves",
        saga.id,
        "Ship marko-ui",
        "--budget",
        "30h",
        "--due",
        "2026-09-20",
        "--commitment",
        "promised",
      ]),
    ).toBe(0);
    const quest = database
      .query("SELECT id, budget_minutes, state, confirmed FROM quests")
      .get() as { id: string; budget_minutes: number; state: string; confirmed: number };
    expect(quest.budget_minutes).toBe(1800);
    expect(quest.state).toBe("started");
    expect(quest.confirmed).toBe(1);
    await run(["quest", "pause", quest.id, "--reason", "waiting on upstream"]);
    expect(
      (
        database.query("SELECT state, state_reason FROM quests").get() as {
          state: string;
          state_reason: string;
        }
      ).state,
    ).toBe("paused");
    await run(["quest", "done", quest.id]);
    expect((database.query("SELECT state FROM quests").get() as { state: string }).state).toBe(
      "done",
    );
  });

  test("branch makes a side quest with a nexus event; return closes it", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Main"]);
    const main = database.query("SELECT id FROM quests").get() as { id: string };
    await run(["quest", "add", "--owner", "hero", "Compare Astryx"]);
    const side = database.query("SELECT id FROM quests WHERE title = 'Compare Astryx'").get() as {
      id: string;
    };
    const left = openStint(new EventStore(database), database, {
      outcome: "fix walk order",
      quest: main.id,
      at: "2026-09-04T15:00:00.000Z",
      actor: "hook",
    });
    expect(
      await run([
        "quest",
        "branch",
        side.id,
        "--deviates-from",
        left,
        "--trigger",
        "what does Astryx do for agents?",
        "--kind",
        "curiosity",
      ]),
    ).toBe(0);
    const row = database
      .query(
        "SELECT deviates_from_stint_id, trigger, branch_kind, returned_at FROM quests WHERE id = ?",
      )
      .get(side.id) as {
      deviates_from_stint_id: string;
      trigger: string;
      branch_kind: string;
      returned_at: string | null;
    };
    expect(row.deviates_from_stint_id).toBe(left);
    expect(row.branch_kind).toBe("curiosity");
    expect(row.returned_at).toBeNull();
    expect(await run(["quest", "return", side.id, "--to", main.id])).toBe(0);
    expect(
      (
        database.query("SELECT returned_at FROM quests WHERE id = ?").get(side.id) as {
          returned_at: string | null;
        }
      ).returned_at,
    ).not.toBeNull();
  });

  test("merge resolves to the target; confirm flips the flag", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    await run(["quest", "add", "--owner", "hero", "B"]);
    const [a, b] = database.query("SELECT id FROM quests ORDER BY title").all() as { id: string }[];
    expect(await run(["quest", "merge", b?.id ?? "", "--into", a?.id ?? ""])).toBe(0);
    expect(
      (
        database.query("SELECT merged_into FROM quests WHERE id = ?").get(b?.id ?? "") as {
          merged_into: string;
        }
      ).merged_into,
    ).toBe(a?.id ?? "");
  });

  test("list hides merged quests unless --all is passed", async () => {
    const { run, database, lines } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    await run(["quest", "add", "--owner", "hero", "B"]);
    const [a, b] = database.query("SELECT id FROM quests ORDER BY title").all() as { id: string }[];
    await run(["quest", "merge", b?.id ?? "", "--into", a?.id ?? ""]);

    lines.length = 0;
    await run(["quest", "list"]);
    expect(lines.some((line) => line.startsWith(`${b?.id}  `))).toBe(false);
    expect(lines.some((line) => line.startsWith(`${a?.id}  `))).toBe(true);

    lines.length = 0;
    await run(["quest", "list", "--all"]);
    expect(lines.some((line) => line.startsWith(`${b?.id}  `))).toBe(true);
  });

  test("assigning a stint to a merged quest resolves through the merge", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    await run(["quest", "add", "--owner", "hero", "B"]);
    const [a, b] = database.query("SELECT id FROM quests ORDER BY title").all() as { id: string }[];
    expect(await run(["quest", "merge", b?.id ?? "", "--into", a?.id ?? ""])).toBe(0);

    const { askQuestion, openStint, recordTrace } = await import("../../src/intent/api");
    const { EventStore } = await import("../../src/intent/store");
    const store = new EventStore(database);
    const stint = openStint(store, database, { outcome: "work", actor: "hook" });
    const trace = recordTrace(store, database, {
      stint,
      tool: "claude-code",
      place: "p",
      source: "session",
      sourceRef: "s",
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:30:00.000Z",
      who: "hero",
      what: "x",
      why: "unknown",
      where: "w",
      how: "h",
      confidence: 0.3,
      classifiedBy: "hook",
      actor: "hook",
    });
    const question = askQuestion(store, database, {
      trace,
      kind: "which_quest",
      text: "Which quest?",
      actor: "hook",
    });
    expect(await run(["answer", question, "--quest", b?.id ?? ""])).toBe(0);
    const row = database.query("SELECT quest_id FROM stints WHERE id = ?").get(stint) as {
      quest_id: string;
    };
    expect(row.quest_id).toBe(a?.id ?? "");
  });

  test("reword without --outcome keeps the existing outcome (no NULL write)", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Q", "--outcome", "Original outcome"]);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    expect(await run(["quest", "reword", quest.id, "New title"])).toBe(0);
    const row = database.query("SELECT title, outcome FROM quests WHERE id = ?").get(quest.id) as {
      title: string;
      outcome: string | null;
    };
    expect(row.title).toBe("New title");
    expect(row.outcome).toBe("Original outcome");
  });

  test("unknown quest id: confirm/pause/resume/done/abandon/branch/return fail without appending events", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    const before = (database.query("SELECT count(*) AS n FROM events").get() as { n: number }).n;

    expect(await run(["quest", "confirm", "nope"])).toBe(1);
    expect(await run(["quest", "pause", "nope"])).toBe(1);
    expect(await run(["quest", "resume", "nope"])).toBe(1);
    expect(await run(["quest", "done", "nope"])).toBe(1);
    expect(await run(["quest", "abandon", "nope"])).toBe(1);
    expect(
      await run(["quest", "branch", "nope", "--deviates-from", "act1", "--trigger", "t"]),
    ).toBe(1);
    expect(await run(["quest", "return", "nope", "--to", "alsonope"])).toBe(1);

    const after = (database.query("SELECT count(*) AS n FROM events").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  test("merge resolves both ids and refuses merging a quest into itself", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    const a = database.query("SELECT id FROM quests").get() as { id: string };

    // direct self-merge is refused
    expect(await run(["quest", "merge", a.id, "--into", a.id])).toBe(1);

    // merging into an unknown quest fails
    expect(await run(["quest", "merge", a.id, "--into", "nope"])).toBe(1);

    // merging an unknown quest fails
    expect(await run(["quest", "merge", "nope", "--into", a.id])).toBe(1);
  });

  test("merge refuses when both sides resolve to the same underlying quest through a prior merge", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    await run(["quest", "add", "--owner", "hero", "B"]);
    const [a, b] = database.query("SELECT id FROM quests ORDER BY title").all() as {
      id: string;
    }[];
    expect(await run(["quest", "merge", b?.id ?? "", "--into", a?.id ?? ""])).toBe(0);
    // b is now merged into a; merging b into a again resolves to the same quest on both sides
    expect(await run(["quest", "merge", b?.id ?? "", "--into", a?.id ?? ""])).toBe(1);
  });

  test("resolveQuest throws on a merge cycle", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);
    await run(["quest", "add", "--owner", "hero", "B"]);
    const [a, b] = database.query("SELECT id FROM quests ORDER BY title").all() as {
      id: string;
    }[];
    // build a cycle directly at the projection level (a -> b -> a)
    database.query("UPDATE quests SET merged_into = ? WHERE id = ?").run(b?.id ?? "", a?.id ?? "");
    database.query("UPDATE quests SET merged_into = ? WHERE id = ?").run(a?.id ?? "", b?.id ?? "");
    expect(() => resolveQuest(database, a?.id ?? "")).toThrow(/cycle/);
  });

  test("answer with --quest new:... never writes the literal string into the event payload", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);

    const { askQuestion, openStint, recordTrace } = await import("../../src/intent/api");
    const { EventStore } = await import("../../src/intent/store");
    const store = new EventStore(database);
    const stint = openStint(store, database, { outcome: "work", actor: "hook" });
    const trace = recordTrace(store, database, {
      stint,
      tool: "claude-code",
      place: "p",
      source: "session",
      sourceRef: "s",
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:30:00.000Z",
      who: "hero",
      what: "x",
      why: "unknown",
      where: "w",
      how: "h",
      confidence: 0.3,
      classifiedBy: "hook",
      actor: "hook",
    });
    const question = askQuestion(store, database, {
      trace,
      kind: "which_quest",
      text: "Which quest?",
      actor: "hook",
    });

    expect(await run(["answer", question, "--quest", 'new:"Explore Astryx"'])).toBe(0);

    const newQuest = database.query("SELECT id, title FROM quests").get() as {
      id: string;
      title: string;
    };
    expect(newQuest.title).toBe('"Explore Astryx"');

    const answeredEvent = database
      .query("SELECT payload FROM events WHERE kind = 'question.answered' AND subject = ?")
      .get(question) as { payload: string };
    const payload = JSON.parse(answeredEvent.payload) as { quest: string };
    expect(payload.quest).toBe(newQuest.id);
    expect(payload.quest.startsWith("new:")).toBe(false);

    const stintRow = database.query("SELECT quest_id FROM stints WHERE id = ?").get(stint) as {
      quest_id: string;
    };
    expect(stintRow.quest_id).toBe(newQuest.id);
  });

  test("rebuild --until <date> prints a warning that projections are stuck in the past", async () => {
    const { run, lines } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "A"]);

    lines.length = 0;
    expect(await run(["rebuild", "--until", "2026-01-01T00:00:00.000Z"])).toBe(0);
    expect(
      lines.some(
        (line) =>
          line ===
          "projections now reflect state as of 2026-01-01T00:00:00.000Z; run tempad rebuild to restore",
      ),
    ).toBe(true);

    lines.length = 0;
    expect(await run(["rebuild"])).toBe(0);
    expect(lines.length).toBe(0);
  });

  test("quest declare with --new creates and declares a quest, printed as 'declared <id> (new)'", async () => {
    const { run, lines } = harness();
    await run(["hero", "init", "S"]);
    lines.length = 0;
    const exitCode = await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Ship the thing",
      "--outcome",
      "get it out",
    ]);
    expect(exitCode).toBe(0);
    expect(lines.at(-1)).toMatch(/^declared .+ \(new\)$/);
  });

  test("quest declare requires exactly one of --quest or --new", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    const exitCode = await run(["quest", "declare", "--session", "s1"]);
    expect(exitCode).toBe(2);
  });

  test("quest declare --origin requires --trigger and --kind", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    const exitCode = await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Side thing",
      "--outcome",
      "investigate",
      "--origin",
      "some-quest-id",
    ]);
    expect(exitCode).toBe(2);
  });

  test("quest declare --new --serves attaches the created quest to a saga", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["saga", "add", "--owner", "hero", "Ship the platform"]);
    const saga = database.query("SELECT id FROM sagas").get() as { id: string };

    const exitCode = await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Ship the thing",
      "--outcome",
      "get it out",
      "--serves",
      saga.id,
    ]);
    expect(exitCode).toBe(0);

    const quest = database
      .query("SELECT serves FROM quests WHERE title = ?")
      .get("Ship the thing") as { serves: string | null };
    expect(quest.serves).toBe(saga.id);
  });

  test("quest declare --new --advances records the contributed-to quest", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Parent effort"]);
    const parent = database.query("SELECT id FROM quests").get() as { id: string };

    const exitCode = await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Contributing work",
      "--outcome",
      "help ship it",
      "--advances",
      parent.id,
    ]);
    expect(exitCode).toBe(0);

    const row = database
      .query("SELECT payload FROM events WHERE kind = 'quest.created' ORDER BY id DESC LIMIT 1")
      .get() as { payload: string };
    expect(JSON.parse(row.payload).advances).toBe(parent.id);
  });

  test("quest declare --new --deviates-from requires --trigger and --kind", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Main effort"]);
    const main = database.query("SELECT id FROM quests").get() as { id: string };

    const exitCode = await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Side thing",
      "--outcome",
      "investigate",
      "--deviates-from",
      main.id,
    ]);
    expect(exitCode).toBe(2);
  });

  test("quest declare --new --deviates-from with --trigger/--kind appends the branch nexus event", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Main effort"]);
    const main = database.query("SELECT id FROM quests").get() as { id: string };

    const exitCode = await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Side thing",
      "--outcome",
      "investigate",
      "--deviates-from",
      main.id,
      "--trigger",
      "noticed something odd",
      "--kind",
      "curiosity",
    ]);
    expect(exitCode).toBe(0);

    const branched = database
      .query("SELECT payload FROM events WHERE kind = 'quest.branched' ORDER BY id DESC LIMIT 1")
      .get() as { payload: string };
    const payload = JSON.parse(branched.payload);
    expect(payload.trigger).toBe("noticed something odd");
    expect(payload.kind).toBe("curiosity");
  });

  test("quest declare --new rejects --advances and --deviates-from together", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Main effort"]);
    const main = database.query("SELECT id FROM quests").get() as { id: string };

    const exitCode = await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--new",
      "Side thing",
      "--outcome",
      "investigate",
      "--advances",
      main.id,
      "--deviates-from",
      main.id,
      "--trigger",
      "t",
      "--kind",
      "unknown",
    ]);
    expect(exitCode).toBe(2);
  });

  test("quest declare rejects --serves/--advances/--deviates-from without --new", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Existing quest"]);
    const existing = database.query("SELECT id FROM quests").get() as { id: string };

    const exitCode = await run([
      "quest",
      "declare",
      "--session",
      "s1",
      "--quest",
      existing.id,
      "--serves",
      "some-saga-id",
    ]);
    expect(exitCode).toBe(2);
  });

  test("quest declare --quest rejects an unknown quest id, exit 1", async () => {
    const { run, lines } = harness();
    await run(["hero", "init", "S"]);
    lines.length = 0;
    const exitCode = await run(["quest", "declare", "--session", "s1", "--quest", "nope"]);
    expect(exitCode).toBe(1);
  });

  test("quest declare --quest rejects a retracted quest id, exit 1", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Retract me"]);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };

    const { EventStore } = await import("../../src/intent/store");
    const { applyIncremental } = await import("../../src/intent/projections");
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "retracted",
        subject: quest.id,
        payload: { retracts: quest.id, reason: "test" },
      }),
    );

    const exitCode = await run(["quest", "declare", "--session", "s1", "--quest", quest.id]);
    expect(exitCode).toBe(1);
  });

  test("quest declare --quest with a valid quest id succeeds", async () => {
    const { run, database, lines } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Existing"]);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    lines.length = 0;
    const exitCode = await run(["quest", "declare", "--session", "s1", "--quest", quest.id]);
    expect(exitCode).toBe(0);
    expect(lines.at(-1)).toBe(`declared ${quest.id}`);
  });

  test("quest declare --done ends the quest's active declaration for the session", async () => {
    const { run, database, lines } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Existing"]);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    await run(["quest", "declare", "--session", "s1", "--quest", quest.id]);
    lines.length = 0;

    const exitCode = await run(["quest", "declare", "--session", "s1", "--done", quest.id]);

    expect(exitCode).toBe(0);
    expect(
      activeDeclaredQuests(database, { sessionId: "s1", at: new Date().toISOString() }),
    ).toEqual([]);
  });

  test("quest declare --done rejects a quest that is not active in the session, exit 1", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Existing"]);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };

    // Never declared in s1: there is nothing for --done to end.
    expect(await run(["quest", "declare", "--session", "s1", "--done", quest.id])).toBe(1);

    // Nor after it has already been ended once.
    await run(["quest", "declare", "--session", "s1", "--quest", quest.id]);
    expect(await run(["quest", "declare", "--session", "s1", "--done", quest.id])).toBe(0);
    expect(await run(["quest", "declare", "--session", "s1", "--done", quest.id])).toBe(1);
  });

  test("quest declare --done rejects an unknown quest id, exit 1", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    expect(await run(["quest", "declare", "--session", "s1", "--done", "nope"])).toBe(1);
  });

  test("quest declare --parent --done ends a subagent's own declaration", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Verify the fix"]);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    await run(["quest", "declare", "--session", "sub", "--parent", "s1", "--quest", quest.id]);

    const exitCode = await run([
      "quest",
      "declare",
      "--session",
      "sub",
      "--parent",
      "s1",
      "--done",
      quest.id,
    ]);

    expect(exitCode).toBe(0);
    expect(
      activeDeclaredQuests(database, {
        sessionId: "sub",
        at: new Date().toISOString(),
        scope: "subagent",
        parentSessionId: "s1",
      }),
    ).toEqual([]);
  });

  test("quest declare --parent --done rejects a quest the subagent never declared", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Verify the fix"]);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    // Declared session-scope for the parent, never for the subagent.
    await run(["quest", "declare", "--session", "s1", "--quest", quest.id]);

    expect(
      await run(["quest", "declare", "--session", "sub", "--parent", "s1", "--done", quest.id]),
    ).toBe(1);
  });

  test("quest declare --done is mutually exclusive with --quest, --new and --plan", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Existing"]);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };

    expect(
      await run(["quest", "declare", "--session", "s1", "--done", quest.id, "--quest", quest.id]),
    ).toBe(2);
    expect(
      await run([
        "quest",
        "declare",
        "--session",
        "s1",
        "--done",
        quest.id,
        "--new",
        "Another",
        "--outcome",
        "x",
      ]),
    ).toBe(2);
    expect(
      await run(["quest", "declare", "--session", "s1", "--done", quest.id, "--plan", "a; b"]),
    ).toBe(2);
  });

  test("tempad quest add sets origin_kind 'declared' on the created quest", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "add", "--owner", "hero", "Hand-added"]);
    const quest = database.query("SELECT origin_kind FROM quests").get() as {
      origin_kind: string;
    };
    expect(quest.origin_kind).toBe("declared");
  });
});
