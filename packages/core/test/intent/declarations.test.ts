import { describe, expect, test } from "bun:test";
import { encodeTime } from "ulid";
import { openDatabase } from "../../src/db/database";
import {
  activeDeclaredQuests,
  currentDeclaredQuest,
  currentDeclaredQuestForSubagent,
  declareQuest,
  hasAnyDeclaration,
} from "../../src/intent/declarations";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";

registerAllProjections();

function seedHero(database: ReturnType<typeof openDatabase>, store: EventStore): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({ actor: "hero", kind: "hero.created", subject: id, payload: { name: "Saulo" } }),
  );
  return id;
}

describe("declarations", () => {
  test("declareQuest with an existing quest id makes it the current declared quest", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const questId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: questId,
        payload: { owner: { kind: "hero", id: heroId }, title: "Ship X", confirmed: true },
      }),
    );

    declareQuest(store, database, {
      sessionId: "s1",
      questId,
      plan: ["write code", "ship it"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    const declared = currentDeclaredQuest(database, {
      sessionId: "s1",
      at: "2026-09-07T09:05:00.000Z",
    });
    expect(declared).toEqual({
      questId,
      title: "Ship X",
      outcome: null,
      plan: ["write code", "ship it"],
      scope: "session",
      parentSessionId: null,
    });
  });

  test("declareQuest with --new creates a declared, confirmed quest and it round-trips", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);

    const result = declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: "New thing", outcome: "do the new thing", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    expect(result.created).toBe(true);
    const quest = database
      .query("SELECT confirmed, origin_kind FROM quests WHERE id = ?")
      .get(result.questId) as { confirmed: number; origin_kind: string };
    expect(quest).toEqual({ confirmed: 1, origin_kind: "declared" });

    const declared = currentDeclaredQuest(database, {
      sessionId: "s1",
      at: "2026-09-07T09:05:00.000Z",
    });
    expect(declared?.questId).toBe(result.questId);
  });

  test("the most recent declaration at or before `at` wins", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const first = declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: "First", outcome: "a", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });
    const second = declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: "Second", outcome: "b", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T10:00:00.000Z",
      heroId,
    });

    expect(
      currentDeclaredQuest(database, { sessionId: "s1", at: "2026-09-07T09:30:00.000Z" })?.questId,
    ).toBe(first.questId);
    expect(
      currentDeclaredQuest(database, { sessionId: "s1", at: "2026-09-07T10:30:00.000Z" })?.questId,
    ).toBe(second.questId);
  });

  test("two declarations at the same instant: the higher uid wins, whatever the local id order", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    for (const [questId, title] of [
      ["QA", "Alpha"],
      ["QB", "Beta"],
    ]) {
      applyIncremental(
        database,
        store.append({
          actor: "hero",
          kind: "quest.created",
          subject: questId as string,
          payload: { owner: { kind: "hero", id: heroId }, title, confirmed: true },
        }),
      );
    }
    const at = "2026-09-07T09:00:00.000Z";
    // Pulled from two hosts: QA's declaration arrived first (lower id) but was
    // made later (higher uid) than QB's.
    for (const [questId, uid] of [
      ["QA", `${encodeTime(Date.parse(at), 10)}0000000000000009`],
      ["QB", `${encodeTime(Date.parse(at), 10)}0000000000000001`],
    ]) {
      database
        .query(
          `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload, uid, sync_host, sync_dirty)
           VALUES (?, ?, 'hero', 's1', 'quest.declared', ?, ?, ?, 'host-b', 0)`,
        )
        .run(
          at,
          at,
          questId as string,
          JSON.stringify({
            session_id: "s1",
            quest_id: questId,
            plan: [],
            scope: "session",
            declared_by: "hero",
            at,
          }),
          uid as string,
        );
    }

    expect(currentDeclaredQuest(database, { sessionId: "s1", at })?.questId).toBe("QA");
    expect(
      activeDeclaredQuests(database, { sessionId: "s1", at }).map((quest) => [
        quest.questId,
        quest.alias,
      ]),
    ).toEqual([
      ["QB", "Q1"],
      ["QA", "Q2"],
    ]);
  });

  test("a subagent declaration is scoped to its parent session and does not leak to the parent's own query", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    declareQuest(store, database, {
      sessionId: "sub1",
      parentSessionId: "s1",
      newQuest: { title: "Subtask", outcome: "help", commitment: "personal" },
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    expect(
      currentDeclaredQuest(database, { sessionId: "s1", at: "2026-09-07T09:05:00.000Z" }),
    ).toBeNull();
    expect(
      currentDeclaredQuestForSubagent(database, {
        sessionId: "sub1",
        parentSessionId: "s1",
        at: "2026-09-07T09:05:00.000Z",
      })?.title,
    ).toBe("Subtask");
  });

  test("hasAnyDeclaration is false until a declaration exists for that session", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    expect(hasAnyDeclaration(database, "s1")).toBe(false);
    declareQuest(store, database, {
      sessionId: "s1",
      newQuest: { title: "X", outcome: "y", commitment: "personal" },
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });
    expect(hasAnyDeclaration(database, "s1")).toBe(true);
  });
});

describe("activeDeclaredQuests", () => {
  /** Creates a quest row so a declaration of it resolves to a title. */
  function seedQuest(
    database: ReturnType<typeof openDatabase>,
    store: EventStore,
    heroId: string,
    title: string,
    outcome: string,
  ): string {
    const questId = newUlid();
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: questId,
        payload: { owner: { kind: "hero", id: heroId }, title, outcome, confirmed: true },
      }),
    );
    return questId;
  }

  test("every declaration of a session stays active, aliased in declaration order", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const first = seedQuest(database, store, heroId, "Ship X", "x shipped");
    const second = seedQuest(database, store, heroId, "Fix Y", "y fixed");

    declareQuest(store, database, {
      sessionId: "s1",
      questId: first,
      plan: ["ship it"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });
    declareQuest(store, database, {
      sessionId: "s1",
      questId: second,
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T10:00:00.000Z",
      heroId,
    });

    const active = activeDeclaredQuests(database, {
      sessionId: "s1",
      at: "2026-09-07T11:00:00.000Z",
    });

    expect(active.map((quest) => quest.alias)).toEqual(["Q1", "Q2"]);
    expect(active.map((quest) => quest.questId)).toEqual([first, second]);
    expect(active[0]).toEqual({
      questId: first,
      title: "Ship X",
      outcome: "x shipped",
      plan: ["ship it"],
      scope: "session",
      parentSessionId: null,
      alias: "Q1",
    });
  });

  test("a done declaration removes its quest and the survivors renumber from the active set", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const first = seedQuest(database, store, heroId, "Ship X", "x shipped");
    const second = seedQuest(database, store, heroId, "Fix Y", "y fixed");

    for (const [questId, at] of [
      [first, "2026-09-07T09:00:00.000Z"],
      [second, "2026-09-07T10:00:00.000Z"],
    ] as const) {
      declareQuest(store, database, {
        sessionId: "s1",
        questId,
        plan: [],
        scope: "session",
        declaredBy: "agent",
        at,
        heroId,
      });
    }
    declareQuest(store, database, {
      sessionId: "s1",
      questId: first,
      done: true,
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T11:00:00.000Z",
      heroId,
    });

    const active = activeDeclaredQuests(database, {
      sessionId: "s1",
      at: "2026-09-07T12:00:00.000Z",
    });

    // The survivor takes Q1: aliases are assigned fresh over the surviving set.
    expect(active.map((quest) => quest.questId)).toEqual([second]);
    expect(active.map((quest) => quest.alias)).toEqual(["Q1"]);
  });

  test("re-declaring an active quest amends its plan without moving its alias", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const first = seedQuest(database, store, heroId, "Ship X", "x shipped");
    const second = seedQuest(database, store, heroId, "Fix Y", "y fixed");

    declareQuest(store, database, {
      sessionId: "s1",
      questId: first,
      plan: ["old plan"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });
    declareQuest(store, database, {
      sessionId: "s1",
      questId: second,
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T10:00:00.000Z",
      heroId,
    });
    declareQuest(store, database, {
      sessionId: "s1",
      questId: first,
      plan: ["new plan", "and more"],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T11:00:00.000Z",
      heroId,
    });

    const active = activeDeclaredQuests(database, {
      sessionId: "s1",
      at: "2026-09-07T12:00:00.000Z",
    });

    expect(active.map((quest) => quest.alias)).toEqual(["Q1", "Q2"]);
    expect(active[0]?.questId).toBe(first);
    expect(active[0]?.plan).toEqual(["new plan", "and more"]);
  });

  test("a declaration after the reference time is not active yet", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const questId = seedQuest(database, store, heroId, "Ship X", "x shipped");

    declareQuest(store, database, {
      sessionId: "s1",
      questId,
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T12:00:00.000Z",
      heroId,
    });

    expect(
      activeDeclaredQuests(database, { sessionId: "s1", at: "2026-09-07T10:00:00.000Z" }),
    ).toEqual([]);
  });

  test("a subagent-scope declaration is not part of the session's active quests", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const questId = seedQuest(database, store, heroId, "Verify the fix", "prove it");

    declareQuest(store, database, {
      sessionId: "s1",
      parentSessionId: "parent",
      questId,
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    expect(
      activeDeclaredQuests(database, { sessionId: "s1", at: "2026-09-07T10:00:00.000Z" }),
    ).toEqual([]);
  });

  test("subagent scope returns the subagent's own declarations and honours done", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const questId = seedQuest(database, store, heroId, "Verify the fix", "prove it");

    declareQuest(store, database, {
      sessionId: "sub",
      parentSessionId: "parent",
      questId,
      plan: ["run the suite"],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    const active = activeDeclaredQuests(database, {
      sessionId: "sub",
      at: "2026-09-07T10:00:00.000Z",
      scope: "subagent",
      parentSessionId: "parent",
    });
    expect(active.map((quest) => quest.questId)).toEqual([questId]);
    expect(active[0]?.alias).toBe("Q1");
    expect(active[0]?.scope).toBe("subagent");
    expect(active[0]?.parentSessionId).toBe("parent");

    declareQuest(store, database, {
      sessionId: "sub",
      parentSessionId: "parent",
      questId,
      done: true,
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-07T11:00:00.000Z",
      heroId,
    });

    expect(
      activeDeclaredQuests(database, {
        sessionId: "sub",
        at: "2026-09-07T12:00:00.000Z",
        scope: "subagent",
        parentSessionId: "parent",
      }),
    ).toEqual([]);
  });

  test("subagent scope ignores a declaration made under a different parent", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const questId = seedQuest(database, store, heroId, "Verify the fix", "prove it");

    declareQuest(store, database, {
      sessionId: "sub",
      parentSessionId: "other-parent",
      questId,
      plan: [],
      scope: "subagent",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    expect(
      activeDeclaredQuests(database, {
        sessionId: "sub",
        at: "2026-09-07T10:00:00.000Z",
        scope: "subagent",
        parentSessionId: "parent",
      }),
    ).toEqual([]);
  });

  test("declareQuest with done and no quest id throws", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);

    expect(() =>
      declareQuest(store, database, {
        sessionId: "s1",
        done: true,
        plan: [],
        scope: "session",
        declaredBy: "agent",
        at: "2026-09-07T09:00:00.000Z",
        heroId,
      }),
    ).toThrow(/--done requires an existing quest id/);
  });

  test("a done declaration creates no quest and appends no quest.created", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const store = new EventStore(database);
    const heroId = seedHero(database, store);
    const questId = seedQuest(database, store, heroId, "Ship X", "x shipped");
    const before = (
      database.query("SELECT COUNT(*) as count FROM events WHERE kind = 'quest.created'").get() as {
        count: number;
      }
    ).count;

    const result = declareQuest(store, database, {
      sessionId: "s1",
      questId,
      done: true,
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-07T09:00:00.000Z",
      heroId,
    });

    expect(result.created).toBe(false);
    expect(
      (
        database
          .query("SELECT COUNT(*) as count FROM events WHERE kind = 'quest.created'")
          .get() as { count: number }
      ).count,
    ).toBe(before);
  });
});
