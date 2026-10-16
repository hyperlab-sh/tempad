import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { askQuestion, openStint, recordTrace, relinkTrace } from "../../src/intent/api";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { EventStore } from "../../src/intent/store";

describe("stints and traces", () => {
  test("record a trace, relink it, history kept", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const first = openStint(store, database, { outcome: "fix walk order", actor: "hook" });
    const second = openStint(store, database, { outcome: "compare Astryx", actor: "hook" });
    const trace = recordTrace(store, database, {
      stint: first,
      tool: "claude-code",
      place: "~/work/marko-ui",
      source: "session",
      sourceRef: "sess-1",
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:30:00.000Z",
      who: "hero",
      what: "reading Astryx docs",
      why: "unknown",
      where: "marko-ui",
      how: "claude-code",
      confidence: 0.4,
      classifiedBy: "hook",
      actor: "hook",
      sessionId: "sess-1",
    });
    relinkTrace(store, database, trace, second, "misclassified", "hero");
    const links = database
      .query(
        "SELECT stint_id, superseded_at FROM trace_links WHERE trace_id = ? ORDER BY linked_at",
      )
      .all(trace) as { stint_id: string; superseded_at: string | null }[];
    expect(links.length).toBe(2);
    expect(links[0]?.superseded_at).not.toBeNull();
    expect(links[1]?.stint_id).toBe(second);
    expect(
      (
        database.query("SELECT stint_id FROM traces WHERE id = ?").get(trace) as {
          stint_id: string;
        }
      ).stint_id,
    ).toBe(second);
  });

  test("answer a question with a new quest links the stint", async () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const lines: string[] = [];
    const context = {
      database,
      config: {} as never,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    };
    await runIntentCommand(["hero", "init", "S"], context);
    const stint = openStint(store, database, { outcome: "compare Astryx", actor: "hook" });
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
      sessionId: "s",
      kind: "which_quest",
      text: "Side quest or new direction?",
      actor: "hook",
    });
    expect(
      await runIntentCommand(
        ["answer", question, "--quest", "new:Compare Astryx", "--why", "curiosity"],
        context,
      ),
    ).toBe(0);
    const row = database
      .query("SELECT state, answer FROM questions WHERE id = ?")
      .get(question) as { state: string; answer: string };
    expect(row.state).toBe("answered");
    const quest = database.query("SELECT id, confirmed FROM quests").get() as {
      id: string;
      confirmed: number;
    };
    expect(quest.confirmed).toBe(0);
    expect(
      (
        database.query("SELECT quest_id FROM stints WHERE id = ?").get(stint) as {
          quest_id: string;
        }
      ).quest_id,
    ).toBe(quest.id);
  });

  test("answer stores why text when --why is given", async () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const lines: string[] = [];
    const context = {
      database,
      config: {} as never,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    };
    await runIntentCommand(["hero", "init", "S"], context);
    const stint = openStint(store, database, { outcome: "compare Astryx", actor: "hook" });
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
      text: "Side quest or new direction?",
      actor: "hook",
    });
    expect(
      await runIntentCommand(
        ["answer", question, "--quest", "new:Compare Astryx", "--why", "curiosity"],
        context,
      ),
    ).toBe(0);
    const row = database
      .query("SELECT answer, answered_by FROM questions WHERE id = ?")
      .get(question) as { answer: string; answered_by: string };
    expect(row.answer).toBe("curiosity");
    expect(row.answered_by).toBe("hero");
  });

  test("answer falls back to the quest reference when --why is omitted", async () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const lines: string[] = [];
    const context = {
      database,
      config: {} as never,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    };
    await runIntentCommand(["hero", "init", "S"], context);
    await runIntentCommand(["quest", "add", "--owner", "hero", "Existing quest"], context);
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    const stint = openStint(store, database, { outcome: "compare Astryx", actor: "hook" });
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
      text: "Side quest or new direction?",
      actor: "hook",
    });
    expect(await runIntentCommand(["answer", question, "--quest", quest.id], context)).toBe(0);
    const row = database.query("SELECT answer FROM questions WHERE id = ?").get(question) as {
      answer: string;
    };
    expect(row.answer).toBe(quest.id);
  });
});

describe("tempad answer --belongs", () => {
  /** A trace under a quest, plus a `belongs` question about it. */
  async function seedBelongsQuestion() {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    const lines: string[] = [];
    const context = {
      database,
      config: {} as never,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    };
    await runIntentCommand(["hero", "init", "S"], context);
    await runIntentCommand(
      ["quest", "add", "Ship marko-ui", "--outcome", "86 components", "--owner", "hero"],
      context,
    );
    const quest = database.query("SELECT id FROM quests").get() as { id: string };
    const stint = openStint(store, database, {
      outcome: "fix walk order",
      quest: quest.id,
      at: "2026-09-04T15:00:00.000Z",
      actor: "hook",
    });
    const trace = recordTrace(store, database, {
      stint,
      tool: "claude-code",
      place: "p",
      source: "session",
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:30:00.000Z",
      who: "hero",
      what: "x",
      why: "unknown",
      where: "w",
      how: "h",
      confidence: 0.9,
      classifiedBy: "assistant",
      actor: "hook",
      sessionId: "s1",
    });
    const question = askQuestion(store, database, {
      trace,
      sessionId: "s1",
      kind: "belongs",
      text: "belongs",
      guess: "a competitor comparison",
      actor: "hook",
    });
    return { database, context, question, stint, quest, store };
  }

  test("--belongs answers the question and leaves the trace and its quest alone", async () => {
    const { database, context, question, stint, quest } = await seedBelongsQuestion();

    expect(
      await runIntentCommand(
        ["answer", question, "--belongs", "--why", "it is the same work"],
        context,
      ),
    ).toBe(0);

    const row = database
      .query("SELECT state, answer FROM questions WHERE id = ?")
      .get(question) as { state: string; answer: string };
    expect(row.state).toBe("answered");
    expect(row.answer).toBe("it is the same work");

    // "Yes it belongs" confirms the declared quest: nothing moves.
    const stintRow = database
      .query("SELECT quest_id as questId FROM stints WHERE id = ?")
      .get(stint) as { questId: string | null };
    expect(stintRow.questId).toBe(quest.id);
    expect(
      (database.query("SELECT COUNT(*) as count FROM quests").get() as { count: number }).count,
    ).toBe(1);
  });

  test("the question.answered payload records belongs: true", async () => {
    const { database, context, question } = await seedBelongsQuestion();

    await runIntentCommand(["answer", question, "--belongs"], context);

    const event = database
      .query("SELECT payload FROM events WHERE kind = 'question.answered' AND subject = ?")
      .get(question) as { payload: string };
    expect(JSON.parse(event.payload).belongs).toBe(true);
  });

  test("--belongs and --quest together are refused", async () => {
    const { context, question } = await seedBelongsQuestion();

    expect(
      await runIntentCommand(["answer", question, "--belongs", "--quest", "new:Other"], context),
    ).toBe(2);
  });

  test("neither --belongs nor --quest is refused", async () => {
    const { context, question } = await seedBelongsQuestion();

    expect(await runIntentCommand(["answer", question], context)).toBe(2);
  });

  test("--belongs on a declare-kind question is refused with a message, exit 1", async () => {
    const { database, context, stint } = await seedBelongsQuestion();
    const store = new EventStore(database);
    const trace = database.query("SELECT id FROM traces").get() as { id: string };
    const declareQuestion = askQuestion(store, database, {
      trace: trace.id,
      sessionId: "s1",
      kind: "declare",
      text: "declare",
      actor: "hook",
    });

    expect(await runIntentCommand(["answer", declareQuestion, "--belongs"], context)).toBe(1);

    const row = database.query("SELECT state FROM questions WHERE id = ?").get(declareQuestion) as {
      state: string;
    };
    expect(row.state).not.toBe("answered");

    const stintRow = database
      .query("SELECT quest_id as questId FROM stints WHERE id = ?")
      .get(stint) as { questId: string | null };
    expect(stintRow.questId).not.toBeNull();
  });

  test("--quest on a belongs question still moves the trace's stint", async () => {
    const { database, context, question, stint } = await seedBelongsQuestion();

    expect(
      await runIntentCommand(
        ["answer", question, "--quest", "new:Compare Astryx", "--why", "different work"],
        context,
      ),
    ).toBe(0);

    const moved = database
      .query("SELECT title FROM quests WHERE id = (SELECT quest_id FROM stints WHERE id = ?)")
      .get(stint) as { title: string };
    expect(moved.title).toBe("Compare Astryx");
  });

  test("--origin current branches from the quest being left, not the reassigned stint", async () => {
    const { database, context, question, stint, quest, store } = await seedBelongsQuestion();

    // An earlier stint of the same session on the declared quest: this is what
    // the side quest actually branched away from.
    const earlier = openStint(store, database, {
      outcome: "the work that was underway",
      quest: quest.id,
      at: "2026-09-04T14:00:00.000Z",
      actor: "hook",
    });
    recordTrace(store, database, {
      stint: earlier,
      tool: "claude-code",
      place: "p",
      source: "session",
      startedAt: "2026-09-04T14:00:00.000Z",
      endedAt: "2026-09-04T14:30:00.000Z",
      who: "hero",
      what: "earlier work",
      why: "ship",
      where: "w",
      how: "h",
      confidence: 0.9,
      classifiedBy: "assistant",
      actor: "hook",
      sessionId: "s1",
    });

    expect(
      await runIntentCommand(
        [
          "answer",
          question,
          "--quest",
          "new:Compare Astryx",
          "--origin",
          "current",
          "--trigger",
          "what does Astryx do for agents?",
          "--kind",
          "curiosity",
        ],
        context,
      ),
    ).toBe(0);

    const branched = database
      .query("SELECT payload FROM events WHERE kind = 'quest.branched'")
      .get() as { payload: string };
    const payload = JSON.parse(branched.payload) as {
      deviates_from: string | null;
      trigger: string;
      kind: string;
    };
    // Never the stint this same command reassigns to the new quest -- that
    // would record the quest as branching from its own stint.
    expect(payload.deviates_from).not.toBe(stint);
    expect(payload.deviates_from).toBe(earlier);
    expect(payload.trigger).toBe("what does Astryx do for agents?");
    expect(payload.kind).toBe("curiosity");

    // The new quest's origin points at the quest that was left, not at itself.
    const originQuest = database
      .query("SELECT quest_id as questId FROM stints WHERE id = ?")
      .get(earlier) as { questId: string | null };
    expect(originQuest.questId).toBe(quest.id);
  });

  test("--origin current falls back to the quest being left when nothing preceded the doubted stint", async () => {
    const { database, context, question } = await seedBelongsQuestion();
    const left = database.query("SELECT id FROM quests").get() as { id: string };

    expect(
      await runIntentCommand(
        ["answer", question, "--quest", "new:Compare Astryx", "--origin", "current"],
        context,
      ),
    ).toBe(0);

    const branched = database
      .query("SELECT payload FROM events WHERE kind = 'quest.branched'")
      .get() as { payload: string };
    // The doubted stint is the session's first on that quest: there is no
    // earlier stint it branched away from, and none is invented. The side quest
    // still deviates from the quest the work was declared under.
    const payload = JSON.parse(branched.payload);
    expect(payload.deviates_from).toBeUndefined();
    expect(payload.deviates_from_quest).toBe(left.id);
    const side = database
      .query(
        "SELECT deviates_from_stint_id, deviates_from_quest_id FROM quests WHERE title = 'Compare Astryx'",
      )
      .get();
    expect(side).toEqual({ deviates_from_stint_id: null, deviates_from_quest_id: left.id });
  });

  test("--origin is refused without a new quest, and an unknown --kind is refused", async () => {
    const { context, question } = await seedBelongsQuestion();

    expect(
      await runIntentCommand(
        ["answer", question, "--quest", "new:X", "--origin", "current", "--kind", "sideways"],
        context,
      ),
    ).toBe(2);
  });
});
