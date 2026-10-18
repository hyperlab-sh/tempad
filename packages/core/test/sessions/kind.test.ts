import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { defaultIntentConfig, type IntentConfig } from "../../src/intent/config";
import { declareQuest } from "../../src/intent/declarations";
import { ensureTables, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import type { SessionKindGuess } from "../../src/sessions/classifier";
import {
  effectiveSessionKind,
  refreshSessionKinds,
  ruleKind,
  type SessionFacts,
  setSessionKind,
} from "../../src/sessions/kind";
import type { SessionKind } from "../../src/sessions/kinds";

registerAllProjections();

interface SeedMessage {
  uuid: string;
  ts: string;
  text: string;
  role?: string;
  originKind?: string | null;
  sidechain?: boolean;
  toolName?: string | null;
}

interface SeedSession {
  id: string;
  startedAt?: string;
  entrypoint?: string | null;
  titleSource?: string | null;
  hostSlug?: string;
  messages?: SeedMessage[];
}

function seedSession(database: ReturnType<typeof openDatabase>, seed: SeedSession): void {
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime,
         entrypoint, title_source)
       VALUES (?, '/c', 'p', ?, '/w', 'personal', 'proj', NULL, 'main',
               ?, ?, ?, 0, '[]', ?, ?, ?, ?)`,
    )
    .run(
      seed.id,
      `/c/p/${seed.id}.jsonl`,
      seed.startedAt ?? "2026-10-02T10:00:00.000Z",
      seed.startedAt ?? "2026-10-02T10:00:00.000Z",
      seed.messages?.length ?? 0,
      seed.hostSlug ?? "host",
      seed.startedAt ?? "2026-10-02T10:00:00.000Z",
      seed.entrypoint ?? null,
      seed.titleSource ?? null,
    );
  const insert = database.query(
    `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview, origin_kind, tool_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const message of seed.messages ?? []) {
    insert.run(
      `${seed.id}-${message.uuid}`,
      seed.id,
      message.ts,
      message.role ?? "user",
      message.sidechain ? 1 : 0,
      message.text,
      message.originKind ?? null,
      message.toolName ?? null,
    );
  }
}

function facts(overrides: Partial<SessionFacts> = {}): SessionFacts {
  return {
    id: "s",
    entrypoint: null,
    titleSource: null,
    hasHumanOrigin: true,
    opener: { uuid: "m1", text: "please fix the login bug", originKind: "human" },
    declaredWithParent: false,
    declaredAsParent: false,
    ...overrides,
  };
}

describe("session kind rules", () => {
  test("every rule fires on facts that satisfy it", () => {
    expect(ruleKind(facts({ entrypoint: "sdk-ts", hasHumanOrigin: false }))).toEqual({
      kind: "automated",
      source: "rule:entrypoint",
      confidence: 1,
    });
    expect(ruleKind(facts({ opener: null, hasHumanOrigin: false }))).toEqual({
      kind: "automated",
      source: "rule:no-user-messages",
      confidence: 1,
    });
    expect(ruleKind(facts({ declaredWithParent: true }))).toEqual({
      kind: "subagent",
      source: "rule:declared-parent",
      confidence: 1,
    });
    expect(ruleKind(facts({ titleSource: "agent-name" }))).toEqual({
      kind: "subagent",
      source: "rule:agent-name",
      confidence: 1,
    });
    expect(
      ruleKind(facts({ opener: { uuid: "m1", text: "take over", originKind: "peer" } })),
    ).toEqual({ kind: "subagent", source: "rule:peer-opener", confidence: 1 });
    expect(
      ruleKind(
        facts({
          opener: { uuid: "m1", text: "  You are the dev for task x", originKind: "human" },
        }),
      ),
    ).toEqual({ kind: "subagent", source: "rule:you-are", confidence: 0.9 });
    expect(ruleKind(facts({ declaredAsParent: true }))).toEqual({
      kind: "lead",
      source: "rule:parent-of",
      confidence: 1,
    });
  });

  test("a plain human opener matches no rule", () => {
    expect(ruleKind(facts())).toBeNull();
    // "you are" only counts capitalized: the operator may type it mid-sentence.
    expect(
      ruleKind(
        facts({ opener: { uuid: "m1", text: "you are the dev for this", originKind: "human" } }),
      ),
    ).toBeNull();
  });

  test("the cheapest rule wins: drop them one at a time and the next fires", () => {
    const all: SessionFacts = {
      id: "s",
      entrypoint: "sdk-cli",
      titleSource: "agent-name",
      hasHumanOrigin: false,
      opener: { uuid: "m1", text: "You are the new squad lead", originKind: null },
      declaredWithParent: true,
      declaredAsParent: true,
    };
    expect(ruleKind(all)?.source).toBe("rule:entrypoint");
    expect(ruleKind({ ...all, entrypoint: null })?.source).toBe("rule:declared-parent");
    expect(ruleKind({ ...all, entrypoint: null, declaredWithParent: false })?.source).toBe(
      "rule:agent-name",
    );
    expect(
      ruleKind({ ...all, entrypoint: null, declaredWithParent: false, titleSource: null })?.source,
    ).toBe("rule:you-are");
    expect(
      ruleKind({
        ...all,
        entrypoint: null,
        declaredWithParent: false,
        titleSource: null,
        opener: { uuid: "m1", text: "You are the new squad lead", originKind: "peer" },
      })?.source,
    ).toBe("rule:peer-opener");
    expect(
      ruleKind({
        ...all,
        entrypoint: null,
        declaredWithParent: false,
        titleSource: null,
        opener: { uuid: "m1", text: "please fix it", originKind: "human" },
      })?.source,
    ).toBe("rule:parent-of");
    expect(
      ruleKind({
        ...all,
        entrypoint: null,
        declaredWithParent: false,
        titleSource: null,
        opener: { uuid: "m1", text: "please fix it", originKind: "human" },
        declaredAsParent: false,
      }),
    ).toBeNull();
    // The opener-only rules never fire without an opener.
    expect(
      ruleKind({
        ...all,
        entrypoint: null,
        declaredWithParent: false,
        titleSource: null,
        declaredAsParent: false,
        opener: null,
      }),
    ).toEqual({
      kind: "automated",
      source: "rule:no-user-messages",
      confidence: 1,
    });
  });

  test("loadSessions: the opener skips CLI meta lines but keeps them when alone", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database, {
      id: "s1",
      startedAt: "2026-10-02T10:00:00.000Z",
      messages: [
        { uuid: "a", ts: "2026-10-02T10:00:01.000Z", text: "<command-name>/clear</command-name>" },
        {
          uuid: "b",
          ts: "2026-10-02T10:00:02.000Z",
          text: "Caveat: the messages below were generated",
        },
        { uuid: "c", ts: "2026-10-02T10:00:03.000Z", text: "real opener", originKind: "human" },
      ],
    });
    seedSession(database, {
      id: "s2",
      startedAt: "2026-10-02T11:00:00.000Z",
      messages: [
        { uuid: "m", ts: "2026-10-02T11:00:01.000Z", text: "<command-name>/clear</command-name>" },
      ],
    });
    const result = await refreshSessionKinds(database, { classifier: null, modelLimit: 0 });
    const rows = database
      .query("SELECT session_id, kind, source FROM session_kind ORDER BY session_id")
      .all() as { session_id: string; kind: string; source: string }[];
    // s1's opener is the first real text (the meta lines are skipped); s2 keeps
    // its meta line as the opener but still has one, so neither is rule-ruled
    // and both stay for the model.
    expect(rows).toEqual([]);
    expect(result.ruled).toBe(0);
    expect(result.pending).toBe(2);
    // A tool_use line is not an opener either.
    seedSession(database, {
      id: "s3",
      messages: [
        { uuid: "t", ts: "2026-10-03T10:00:00.000Z", text: "tool output", toolName: "Read" },
        { uuid: "u", ts: "2026-10-03T10:00:01.000Z", text: "You are the dev", originKind: "human" },
      ],
    });
    await refreshSessionKinds(database, { classifier: null, modelLimit: 0 });
    const s3 = effectiveSessionKind(database, "s3");
    expect(s3?.source).toBe("rule:you-are");
  });

  test("a quest.declared with a parent marks the declarer subagent and the parent lead", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database, {
      id: "lead",
      messages: [
        {
          uuid: "l1",
          ts: "2026-10-02T10:00:00.000Z",
          text: "plan the sprint",
          originKind: "human",
        },
      ],
    });
    seedSession(database, {
      id: "sub",
      messages: [
        { uuid: "s1", ts: "2026-10-02T11:00:00.000Z", text: "do the work", originKind: "human" },
      ],
    });
    declareQuest(new EventStore(database), database, {
      sessionId: "sub",
      parentSessionId: "lead",
      newQuest: { title: "T", outcome: "O", commitment: "personal" },
      plan: [],
      scope: "subagent",
      declaredBy: "hero",
      at: new Date().toISOString(),
      heroId: "H",
    });
    await refreshSessionKinds(database, { classifier: null, modelLimit: 0 });
    expect(effectiveSessionKind(database, "sub")).toEqual({
      kind: "subagent",
      source: "rule:declared-parent",
      confidence: 1,
    });
    expect(effectiveSessionKind(database, "lead")).toEqual({
      kind: "lead",
      source: "rule:parent-of",
      confidence: 1,
    });
  });
});

function fakeClassifier(handler: (text: string, call: number) => SessionKindGuess | Error): {
  classifyOpener(text: string): Promise<SessionKindGuess>;
  texts: string[];
} {
  const texts: string[] = [];
  return {
    texts,
    async classifyOpener(text: string): Promise<SessionKindGuess> {
      texts.push(text);
      const answer = handler(text, texts.length);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe("refreshSessionKinds", () => {
  test("rules cache every session; a second pass changes nothing; a stale rule row is cleared", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database, {
      id: "s1",
      messages: [
        { uuid: "m", ts: "2026-10-02T10:00:00.000Z", text: "You are the dev", originKind: "human" },
      ],
    });
    seedSession(database, {
      id: "s2",
      messages: [{ uuid: "m", ts: "2026-10-02T09:00:00.000Z", text: "hello", originKind: "human" }],
    });
    const first = await refreshSessionKinds(database, { classifier: null, modelLimit: 0 });
    expect(first.ruled).toBe(1);
    const second = await refreshSessionKinds(database, { classifier: null, modelLimit: 0 });
    expect(second.ruled).toBe(0);
    expect(second.cleared).toBe(0);

    // The rule no longer fires (the transcript gained a plain human opener).
    database
      .query("UPDATE claude_messages SET text_preview = 'plain question' WHERE session_id = 's1'")
      .run();
    const third = await refreshSessionKinds(database, { classifier: null, modelLimit: 0 });
    expect(third.ruled).toBe(0);
    expect(third.cleared).toBe(1);
    expect(effectiveSessionKind(database, "s1")).toBeNull();
  });

  test("leftovers go to the model, newest first, capped by modelLimit", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    for (const id of ["old", "mid", "new"]) {
      seedSession(database, {
        id,
        startedAt: `2026-10-0${id === "old" ? 2 : id === "mid" ? 3 : 4}T10:00:00.000Z`,
        messages: [
          {
            uuid: "m",
            ts: "2026-10-02T10:00:01.000Z",
            text: "a plain opener",
            originKind: "human",
          },
        ],
      });
    }
    const model = fakeClassifier(() => ({ kind: "human", confidence: 0.8 }));
    const result = await refreshSessionKinds(database, { classifier: model, modelLimit: 2 });
    expect(result.modeled).toBe(2);
    expect(result.pending).toBe(1);
    expect(
      database
        .query("SELECT session_id FROM session_kind ORDER BY session_id")
        .all()
        .map((row) => (row as { session_id: string }).session_id),
    ).toEqual(["mid", "new"]);
    expect(effectiveSessionKind(database, "old")).toBeNull();
    // A current-version model row is never re-sent; the pending one is.
    const again = await refreshSessionKinds(database, { classifier: model, modelLimit: 2 });
    expect(again.modeled).toBe(1);
    expect(again.pending).toBe(0);
    // A version bump re-sends everything the model classified.
    database.query("UPDATE session_kind SET classifier_version = 0").run();
    const bumped = await refreshSessionKinds(database, { classifier: model, modelLimit: 10 });
    expect(bumped.modeled).toBe(3);
  });

  test("a manual override is never sent to the model", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database, {
      id: "s1",
      messages: [
        { uuid: "m", ts: "2026-10-02T10:00:00.000Z", text: "a plain opener", originKind: "human" },
      ],
    });
    setSessionKind(database, "s1", "lead");
    const model = fakeClassifier(() => {
      throw new Error("must not be called");
    });
    const result = await refreshSessionKinds(database, { classifier: model, modelLimit: 10 });
    expect(result.pending).toBe(0);
    expect(effectiveSessionKind(database, "s1")).toEqual({
      kind: "lead",
      source: "manual",
      confidence: 1,
    });
  });

  test("the host filter keeps other hosts' sessions away from the model", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    for (const [id, slug] of [
      ["mine", "this-host"],
      ["theirs", "other-host"],
    ] as const) {
      seedSession(database, {
        id,
        hostSlug: slug,
        messages: [
          { uuid: "m", ts: "2026-10-02T10:00:00.000Z", text: "plain", originKind: "human" },
        ],
      });
    }
    const model = fakeClassifier(() => ({ kind: "human", confidence: 1 }));
    const result = await refreshSessionKinds(database, {
      classifier: model,
      modelLimit: 10,
      hostSlug: "this-host",
    });
    expect(result.modeled).toBe(1);
    // The other host's session is outside this host's batch entirely, so it is
    // not pending here either: its own host classifies it.
    expect(result.pending).toBe(0);
    expect(effectiveSessionKind(database, "theirs")).toBeNull();
  });

  test("a bad answer fails that session and the batch continues; a transport failure ends it", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    for (const id of ["a", "b", "c"]) {
      seedSession(database, {
        id,
        startedAt: `2026-10-0${2 + "abc".indexOf(id)}T10:00:00.000Z`,
        messages: [
          { uuid: "m", ts: "2026-10-02T10:00:01.000Z", text: "plain", originKind: "human" },
        ],
      });
    }
    const { ClassifierResponseError } = await import("../../src/w5/classifier-shared");
    let call = 0;
    const model = {
      classifyOpener: async () => {
        call += 1;
        if (call === 1) throw new ClassifierResponseError("bad json", "nope");
        if (call === 2) throw new Error("claude cli timed out");
        return { kind: "human" as SessionKind, confidence: 1 };
      },
    };
    const logs: string[] = [];
    const result = await refreshSessionKinds(database, {
      classifier: model,
      modelLimit: 10,
      log: (line) => logs.push(line),
    });
    expect(result.modeled).toBe(0);
    expect(result.failed).toBe(2);
    // 'a' (bad answer) is retried next pass; 'b' ended the batch, 'c' stays pending.
    expect(result.pending).toBe(1);
    expect(logs.length).toBe(2);
  });

  test("the model sees the full transcript text, falling back to the preview", async () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    const home = mkdtempSync(join(tmpdir(), "tempad-kind-test-"));
    const transcript = join(home, "session.jsonl");
    const long = "x".repeat(600);
    writeFileSync(transcript, `${JSON.stringify({ uuid: "s1-m1", message: { content: long } })}\n`);
    seedSession(database, {
      id: "s1",
      messages: [
        {
          uuid: "m1",
          ts: "2026-10-02T10:00:00.000Z",
          text: long.slice(0, 60),
          originKind: "human",
        },
      ],
    });
    database.query("UPDATE claude_sessions SET file_path = ? WHERE id = 's1'").run(transcript);
    const seen: string[] = [];
    const model = {
      classifyOpener: async (text: string) => {
        seen.push(text);
        return { kind: "human" as SessionKind, confidence: 1 };
      },
    };
    await refreshSessionKinds(database, { classifier: model, modelLimit: 1 });
    expect(seen[0]?.length).toBe(600);

    // A missing transcript falls back to the preview text.
    seedSession(database, {
      id: "s2",
      startedAt: "2026-10-03T10:00:00.000Z",
      messages: [
        { uuid: "m2", ts: "2026-10-03T10:00:00.000Z", text: "preview only", originKind: "human" },
      ],
    });
    await refreshSessionKinds(database, { classifier: model, modelLimit: 1 });
    expect(seen[1]).toBe("preview only");
  });
});

describe("manual session kind", () => {
  test("a manual set wins over inference and survives a rebuild; --clear hands it back", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database, {
      id: "s1",
      messages: [
        { uuid: "m", ts: "2026-10-02T10:00:00.000Z", text: "You are the dev", originKind: "human" },
      ],
    });
    setSessionKind(database, "s1", "lead");
    expect(effectiveSessionKind(database, "s1")).toEqual({
      kind: "lead",
      source: "manual",
      confidence: 1,
    });
    rebuildAll(database);
    expect(effectiveSessionKind(database, "s1")?.kind).toBe("lead");
    // Clearing appends a kind-less event: inference takes over again.
    setSessionKind(database, "s1", null);
    expect(effectiveSessionKind(database, "s1")).toBeNull();
    const events = database
      .query("SELECT payload FROM events WHERE kind = 'session.kind_set' ORDER BY id")
      .all() as { payload: string }[];
    expect(events.map((row) => JSON.parse(row.payload).kind)).toEqual(["lead", null]);
  });
});

describe("sessions cli", () => {
  function makeContext(database: ReturnType<typeof openDatabase>, intentConfig?: IntentConfig) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      context: {
        database,
        home: mkdtempSync(join(tmpdir(), "tempad-kind-cli-")),
        intentConfig: intentConfig ?? defaultIntentConfig(),
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
      },
      stdout,
      stderr,
    };
  }

  test("list shows manual and inferred kinds and --kind filters them", async () => {
    const { runSessionsCommand } = await import("../../src/sessions/cli");
    const database = openDatabase(":memory:");
    ensureTables(database);
    const recent = new Date().toISOString();
    seedSession(database, {
      id: "s1",
      startedAt: recent,
      messages: [{ uuid: "m", ts: recent, text: "You are the dev", originKind: "human" }],
    });
    seedSession(database, {
      id: "s2",
      startedAt: recent,
      messages: [{ uuid: "m", ts: recent, text: "hello", originKind: "human" }],
    });
    setSessionKind(database, "s2", "lead");
    await refreshSessionKinds(database, { classifier: null, modelLimit: 0 });
    const made = makeContext(database);
    const { context, stdout } = made;
    await runSessionsCommand([], context);
    const s1 = stdout.find((line) => line.includes("s1"));
    const s2 = stdout.find((line) => line.includes("s2"));
    expect(s1).toContain("subagent (rule:you-are)");
    expect(s2).toContain("lead (manual)");
    // --kind keeps only sessions of that effective kind.
    const { context: filtered, stdout: only } = makeContext(database);
    await runSessionsCommand(["--kind", "subagent"], filtered);
    expect(only.length).toBe(1);
    expect(only[0]).toContain("s1");
    // A bad kind is a usage error.
    const { context: bad } = makeContext(database);
    expect(await runSessionsCommand(["--kind", "robot"], bad)).toBe(2);
  });

  test("kind --set/--clear/--refresh", async () => {
    const { runSessionsCommand } = await import("../../src/sessions/cli");
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database, {
      id: "s1",
      messages: [{ uuid: "m", ts: new Date().toISOString(), text: "hello", originKind: "human" }],
    });
    const made3 = makeContext(database);
    const { context, stdout, stderr } = made3;

    expect(await runSessionsCommand(["kind", "s1", "--set", "human"], context)).toBe(0);
    expect(stdout.at(-1)).toContain("s1 human source=manual");
    expect(await runSessionsCommand(["kind", "s1", "--clear"], context)).toBe(0);
    expect(stdout.at(-1)).toContain("unknown (not classified yet)");

    // Clearing again: nothing to clear.
    expect(await runSessionsCommand(["kind", "s1", "--clear"], context)).toBe(1);
    expect(stderr.at(-1)).toContain("no manual kind");

    // An unknown session id is refused before any event is appended.
    const before = database.query("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(await runSessionsCommand(["kind", "nope", "--set", "human"], context)).toBe(1);
    expect(stderr.at(-1)).toContain("unknown claude session");
    const after = database.query("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(after.n).toBe(before.n);

    // --refresh runs the pass (rules only with limit 0) and prints its summary.
    const { context: refreshCtx, stdout: refreshOut } = makeContext(database);
    expect(await runSessionsCommand(["kind", "--refresh", "--limit", "0"], refreshCtx)).toBe(0);
    expect(refreshOut.at(-1)).toMatch(/^sessions: kinds ruled=/);
    // --refresh with a session id is a usage error.
    expect(await runSessionsCommand(["kind", "s1", "--refresh"], context)).toBe(2);
  });
});

describe("review --kind", () => {
  test("keeps only doubted traces from sessions of that kind, a manual kind first", async () => {
    const { runReviewCommand } = await import("../../src/w5/cli");
    const database = openDatabase(":memory:");
    ensureTables(database);
    const now = new Date().toISOString();
    for (const id of ["s1", "s2"]) {
      database
        .query(
          `INSERT INTO stints (id, quest_id, outcome, opened_at, revision)
           VALUES (?, NULL, 'o', ?, 1)`,
        )
        .run(id === "s1" ? "A1" : "A2", now);
      database
        .query(
          `INSERT INTO traces
            (id, stint_id, tool, place, source, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at, doubt)
            VALUES (?, ?, 'claude-code', 'p', 'session', ?, ?, 'hero', 'w', 'y', 'p', 'claude-code', 0.9, 'assistant', ?, ?, 'unrecognized quest alias')`,
        )
        .run(id === "s1" ? "T1" : "T2", id === "s1" ? "A1" : "A2", now, now, id, now);
    }
    // s2 is inferred human; s1 is manually overridden to lead.
    database
      .query(
        "INSERT INTO session_kind (session_id, kind, source, confidence, classifier_version, computed_at) VALUES ('s2', 'human', 'model', 0.9, 1, ?)",
      )
      .run(now);
    setSessionKind(database, "s1", "lead");

    const config = {
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
      home: mkdtempSync(join(tmpdir(), "tempad-review-")),
    } as unknown as import("../../src/config/env").Config;
    const lines: string[] = [];
    const code = runReviewCommand(["--kind", "lead"], {
      database,
      config,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.some((line) => line.includes("T1"))).toBe(true);
    expect(lines.some((line) => line.includes("T2"))).toBe(false);
    // A kind no pass classified yet matches nothing.
    const all: string[] = [];
    runReviewCommand(["--kind", "automated"], {
      database,
      config,
      intentConfig: defaultIntentConfig(),
      stdout: (line: string) => all.push(line),
    });
    expect(all.some((line) => line.includes("T1") || line.includes("T2"))).toBe(false);
  });
});
