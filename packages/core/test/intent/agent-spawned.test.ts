import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { newUlid } from "../../src/intent/ids";
import { applyIncremental, ensureTables, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { runSyncEngine } from "../../src/sync/engine";
import { contextActiveQuests } from "../../src/w5/cli";
import { FakeRemote, openHost, temporaryDirectory } from "../sync/helpers";

registerAllProjections();

function harness() {
  const database = openDatabase(":memory:");
  ensureTables(database);
  const lines: string[] = [];
  const context = {
    database,
    config: {} as never,
    intentConfig: {} as never,
    stdout: (line: string) => lines.push(line),
  };
  return { database, lines, run: (args: string[]) => runIntentCommand(args, context) };
}

function seedQuest(database: Database, store: EventStore, title: string): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: "hero",
      kind: "quest.created",
      subject: id,
      payload: { owner: { kind: "hero", id: "hero" }, title, confirmed: true },
    }),
  );
  return id;
}

describe("tempad agent spawned", () => {
  test("records one agent.spawned fact with the spawn details", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    const code = await run([
      "agent",
      "spawned",
      "--parent",
      "lead1",
      "--child",
      "kid1",
      "--role",
      "developer",
      "--harness",
      "pi",
      "--model",
      "glm-5.3",
      "--effort",
      "high",
      "--ref",
      "tempad-l1a",
      "--title",
      "Agent spawned event",
    ]);
    expect(code).toBe(0);
    const rows = database
      .query("SELECT kind, subject, payload, at FROM events WHERE kind = 'agent.spawned'")
      .all() as { kind: string; subject: string; payload: string; at: string }[];
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (!row) throw new Error("no agent.spawned event");
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.parent_session_id).toBe("lead1");
    expect(payload.child_session_id).toBe("kid1");
    expect(payload.role).toBe("developer");
    expect(payload.harness).toBe("pi");
    expect(payload.model).toBe("glm-5.3");
    expect(payload.effort).toBe("high");
    expect(payload.ref).toBe("tempad-l1a");
    expect(payload.title).toBe("Agent spawned event");
    // `at` is stamped on the event itself, not only in the payload.
    expect(row.at).toBe(payload.at as string);
    // Omitted flags are absent from the payload, never null.
    expect(Object.keys(payload)).not.toContain("quest_id");
  });

  test("--child with an explicit --quest also declares the quest for the child", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    const store = new EventStore(database);
    const questId = seedQuest(database, store, "Ship l1a");
    const code = await run([
      "agent",
      "spawned",
      "--parent",
      "lead1",
      "--child",
      "kid1",
      "--role",
      "developer",
      "--harness",
      "claude",
      "--quest",
      questId,
      "--title",
      "Agent spawned event",
    ]);
    expect(code).toBe(0);
    const declared = database
      .query(
        `SELECT payload FROM events WHERE kind = 'quest.declared'
           AND json_extract(payload, '$.session_id') = 'kid1'`,
      )
      .all() as { payload: string }[];
    expect(declared.length).toBe(1);
    const first = declared[0];
    if (!first) throw new Error("no quest.declared event");
    const payload = JSON.parse(first.payload) as Record<string, unknown>;
    expect(payload.quest_id).toBe(questId);
    expect(payload.scope).toBe("subagent");
    expect(payload.parent_session_id).toBe("lead1");
    expect(payload.plan).toEqual(["Agent spawned event"]);
    expect(payload.declared_by).toBe("agent");
  });

  test("no --quest: the parent's single active quest is used", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run([
      "quest",
      "declare",
      "--session",
      "lead1",
      "--new",
      "Ship l1a",
      "--outcome",
      "ship it",
    ]);
    const code = await run([
      "agent",
      "spawned",
      "--parent",
      "lead1",
      "--child",
      "kid1",
      "--role",
      "reviewer",
      "--harness",
      "claude",
    ]);
    expect(code).toBe(0);
    const quest = database
      .query(
        `SELECT json_extract(payload, '$.quest_id') AS questId, json_extract(payload, '$.scope') AS scope,
                json_extract(payload, '$.parent_session_id') AS parentSessionId
           FROM events WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = 'kid1'`,
      )
      .get() as { questId: string; scope: string; parentSessionId: string };
    const parentId = database
      .query(
        `SELECT json_extract(payload, '$.quest_id') AS questId FROM events
          WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = 'lead1'`,
      )
      .get() as { questId: string };
    expect(quest.questId).toBe(parentId.questId);
    expect(quest.scope).toBe("subagent");
    expect(quest.parentSessionId).toBe("lead1");
  });

  test("no --quest and several active parent quests: spawn only, candidates printed", async () => {
    const { run, database, lines } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "declare", "--session", "lead1", "--new", "Ship A", "--outcome", "a"]);
    await run(["quest", "declare", "--session", "lead1", "--new", "Ship B", "--outcome", "b"]);
    const code = await run([
      "agent",
      "spawned",
      "--parent",
      "lead1",
      "--child",
      "kid1",
      "--role",
      "mechanic",
      "--harness",
      "pi",
    ]);
    expect(code).toBe(0);
    const spawns = database
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.spawned'")
      .get() as { n: number };
    expect(spawns.n).toBe(1);
    const declared = database
      .query(
        `SELECT COUNT(*) AS n FROM events WHERE kind = 'quest.declared'
           AND json_extract(payload, '$.session_id') = 'kid1'`,
      )
      .get() as { n: number };
    expect(declared.n).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("--quest");
    expect(output).toContain("Ship A");
    expect(output).toContain("Ship B");
  });

  test("no --child: the spawn fact only, no declaration even with --quest", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run([
      "quest",
      "declare",
      "--session",
      "lead1",
      "--new",
      "Ship l1a",
      "--outcome",
      "ship it",
    ]);
    const questId = (
      database
        .query(
          `SELECT json_extract(payload, '$.quest_id') AS questId FROM events
            WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = 'lead1'`,
        )
        .get() as { questId: string }
    ).questId;
    const code = await run([
      "agent",
      "spawned",
      "--parent",
      "lead1",
      "--role",
      "squad-leader",
      "--harness",
      "pi",
      "--quest",
      questId,
    ]);
    expect(code).toBe(0);
    const declared = database
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'quest.declared'")
      .get() as { n: number };
    // Exactly the lead's own declaration; nothing written for a child.
    expect(declared.n).toBe(1);
  });

  test("unknown quest, bad role and bad harness fail without writing events", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    expect(
      await run([
        "agent",
        "spawned",
        "--parent",
        "lead1",
        "--child",
        "k",
        "--role",
        "dev",
        "--harness",
        "claude",
      ]),
    ).toBe(2);
    expect(
      await run([
        "agent",
        "spawned",
        "--parent",
        "lead1",
        "--child",
        "k",
        "--role",
        "developer",
        "--harness",
        "moca",
      ]),
    ).toBe(2);
    expect(
      await run([
        "agent",
        "spawned",
        "--parent",
        "lead1",
        "--child",
        "k",
        "--role",
        "developer",
        "--harness",
        "claude",
        "--quest",
        "01NOPE",
      ]),
    ).toBe(1);
    const spawns = database
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.spawned'")
      .get() as { n: number };
    expect(spawns.n).toBe(0);
  });

  test("no --child: the parent's single active quest still lands on the fact", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    await run([
      "quest",
      "declare",
      "--session",
      "lead1",
      "--new",
      "Ship l1a",
      "--outcome",
      "ship it",
    ]);
    const code = await run([
      "agent",
      "spawned",
      "--parent",
      "lead1",
      "--role",
      "developer",
      "--harness",
      "pi",
      "--model",
      "glm-5.3:xhigh",
    ]);
    expect(code).toBe(0);
    const parentId = database
      .query(
        `SELECT json_extract(payload, '$.quest_id') AS questId FROM events
          WHERE kind = 'quest.declared' AND json_extract(payload, '$.session_id') = 'lead1'`,
      )
      .get() as { questId: string };
    const payload = JSON.parse(
      (
        database.query("SELECT payload FROM events WHERE kind = 'agent.spawned'").get() as {
          payload: string;
        }
      ).payload,
    ) as Record<string, unknown>;
    expect(payload.quest_id).toBe(parentId.questId);
    // No child id, so there is nothing to declare for: the fact carries the
    // attribution on its own.
    const declared = database
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'quest.declared'")
      .get() as { n: number };
    expect(declared.n).toBe(1);
  });

  test("no --child and several active parent quests: fact without quest_id, candidates printed", async () => {
    const { run, database, lines } = harness();
    await run(["hero", "init", "S"]);
    await run(["quest", "declare", "--session", "lead1", "--new", "Ship A", "--outcome", "a"]);
    await run(["quest", "declare", "--session", "lead1", "--new", "Ship B", "--outcome", "b"]);
    const code = await run([
      "agent",
      "spawned",
      "--parent",
      "lead1",
      "--role",
      "mechanic",
      "--harness",
      "pi",
    ]);
    expect(code).toBe(0);
    const payload = JSON.parse(
      (
        database.query("SELECT payload FROM events WHERE kind = 'agent.spawned'").get() as {
          payload: string;
        }
      ).payload,
    ) as Record<string, unknown>;
    expect("quest_id" in payload).toBe(false);
    const output = lines.join("\n");
    expect(output).toContain("--quest");
    expect(output).toContain("Ship A");
    expect(output).toContain("Ship B");
  });

  test("missing required flags is a usage error", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    expect(await run(["agent", "spawned", "--role", "developer", "--harness", "claude"])).toBe(2);
    expect(await run(["agent", "spawned", "--parent", "lead1"])).toBe(2);
    expect(await run(["agent", "other"])).toBe(2);
  });

  test("agent.spawned and its child declaration survive push, pull and rebuild", async () => {
    const directory = temporaryDirectory();
    const remote = new FakeRemote();
    const lead = openHost(directory, "host-a");
    const follower = openHost(directory, "host-b");
    try {
      const context = {
        database: lead,
        config: {} as never,
        intentConfig: {} as never,
        stdout: () => {},
      };
      await runIntentCommand(["hero", "init", "S"], context);
      await runIntentCommand(
        ["quest", "declare", "--session", "lead1", "--new", "Ship l1a", "--outcome", "ship it"],
        context,
      );
      expect(
        await runIntentCommand(
          [
            "agent",
            "spawned",
            "--parent",
            "lead1",
            "--child",
            "kid1",
            "--role",
            "developer",
            "--harness",
            "claude",
            "--model",
            "sonnet",
            "--title",
            "Agent spawned event",
          ],
          context,
        ),
      ).toBe(0);

      await runSyncEngine(lead, remote, {
        hostSlug: "host-a",
        batchSize: 500,
        push: true,
        pull: true,
      });
      const pulled = await runSyncEngine(follower, remote, {
        hostSlug: "host-b",
        batchSize: 500,
        push: true,
        pull: true,
      });
      expect(pulled.pulled.events).toBeGreaterThan(0);
      expect(pulled.rebuilt).toBe(true);

      const spawn = follower
        .query("SELECT uid, payload FROM events WHERE kind = 'agent.spawned'")
        .get() as { uid: string; payload: string };
      const original = lead
        .query("SELECT uid, payload FROM events WHERE kind = 'agent.spawned'")
        .get() as { uid: string; payload: string };
      expect(spawn.uid).toBe(original.uid);
      expect(JSON.parse(spawn.payload)).toEqual(JSON.parse(original.payload));

      // The subagent declaration arrived and resolves for the child.
      expect(
        follower
          .query(
            `SELECT COUNT(*) AS n FROM events WHERE kind = 'quest.declared'
             AND json_extract(payload, '$.session_id') = 'kid1'`,
          )
          .get(),
      ).toEqual({ n: 1 });
      expect(
        contextActiveQuests(follower, { sessionId: "kid1", at: new Date().toISOString() }),
      ).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Ship l1a" })]));

      // Projections rebuild from the pulled events alone.
      registerAllProjections();
      rebuildAll(follower);
      expect(
        contextActiveQuests(follower, { sessionId: "kid1", at: new Date().toISOString() }),
      ).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Ship l1a" })]));
    } finally {
      lead.close();
      follower.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
