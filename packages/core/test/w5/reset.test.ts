import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { applyIncremental, ensureTables, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { runReviewCommand, runW5Command } from "../../src/w5/cli";
import { advanceQuestions } from "../../src/w5/questions";
import { applyReset, planReset } from "../../src/w5/reset";

registerAllProjections();

type TestDatabase = ReturnType<typeof openDatabase>;

const FROM = "2026-09-04T00:00:00.000Z";
const RESET_REASON = "eval reset";

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

function append(
  database: TestDatabase,
  store: EventStore,
  actor: "hero" | "hook" | "backfill" | "system",
  kind: string,
  subject: string,
  payload: Record<string, unknown>,
) {
  applyIncremental(
    database,
    store.append({ actor, kind: kind as never, subject, payload, sessionId: undefined }),
  );
}

function seedSession(database: TestDatabase, id: string, endedAt: string) {
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES (?, '/c', 'p', ?, '/w/p', 'personal', 'p', 't', 'main', ?, ?, 1, 0, '[]', 'host', ?)`,
    )
    .run(id, `/c/p/${id}.jsonl`, endedAt, endedAt, endedAt);
  database
    .query(
      "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES (?, ?, ?, 'user', 0, 'work')",
    )
    .run(`${id}-m0`, id, endedAt);
}

/** A w5-inferred session: an unconfirmed quest, a stint on it and one trace. */
function seedInferred(
  database: TestDatabase,
  store: EventStore,
  id: string,
  options: { endedAt?: string; confirmedQuest?: boolean; traceActor?: "backfill" | "hero" } = {},
) {
  const endedAt = options.endedAt ?? "2026-09-04T15:00:00.000Z";
  seedSession(database, id, endedAt);
  append(database, store, "hook", "quest.created", `Q-${id}`, {
    owner: { kind: "hero", id: "H1" },
    title: `quest of ${id}`,
    outcome: "o",
    commitment: "focused",
    confirmed: options.confirmedQuest === true,
  });
  append(database, store, "hook", "stint.opened", `A-${id}`, {
    outcome: "inferred work",
    quest: `Q-${id}`,
  });
  applyIncremental(
    database,
    store.append({
      actor: options.traceActor ?? "backfill",
      kind: "trace.recorded",
      subject: `T-${id}`,
      sessionId: id,
      payload: {
        stint: `A-${id}`,
        tool: "claude-code",
        place: "personal/p",
        source: "session",
        started_at: endedAt,
        ended_at: endedAt,
        who: "hero",
        what: "inferred work",
        why: "ship",
        where: "personal/p",
        how: "claude-code",
        confidence: 0.9,
        classified_by: "assistant",
      },
    }),
  );
  applyIncremental(
    database,
    store.append({
      actor: "backfill",
      kind: "window.classified",
      subject: id,
      sessionId: id,
      at: endedAt,
      payload: { session: id, startedAt: endedAt, endedAt },
    }),
  );
}

const counts = (database: TestDatabase) => ({
  traces: (
    database.query("SELECT COUNT(*) AS n FROM traces WHERE retracted_at IS NULL").get() as {
      n: number;
    }
  ).n,
  stints: (
    database.query("SELECT COUNT(*) AS n FROM stints WHERE retracted_at IS NULL").get() as {
      n: number;
    }
  ).n,
  quests: (
    database.query("SELECT COUNT(*) AS n FROM quests WHERE retracted_at IS NULL").get() as {
      n: number;
    }
  ).n,
  events: (database.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
});

/** A question the way `question.asked` writes it, brought to `state`. */
function seedQuestion(
  database: TestDatabase,
  store: EventStore,
  input: {
    id: string;
    traceId: string;
    sessionId: string;
    state: "watching" | "asked" | "expired" | "answered" | "resolved_by_context";
    kind?: string;
  },
) {
  applyIncremental(
    database,
    store.append({
      actor: "system",
      kind: "question.asked",
      subject: input.id,
      sessionId: input.sessionId,
      payload: { trace: input.traceId, text: "why?", kind: input.kind ?? "belongs", guess: "g" },
    }),
  );
  if (input.state === "watching") return;
  if (input.state === "answered") {
    append(database, store, "hero", "question.answered", input.id, { answeredBy: "hero" });
    return;
  }
  if (input.state === "resolved_by_context") {
    append(database, store, "system", "question.answered", input.id, { answeredBy: "context" });
    return;
  }
  if (input.state === "asked") {
    append(database, store, "system", "question.promoted", input.id, { turnsAtAsk: 1 });
    return;
  }
  append(database, store, "system", "question.expired", input.id, {});
}

const questionStates = (database: TestDatabase) =>
  Object.fromEntries(
    (
      database.query("SELECT id, state FROM questions ORDER BY id").all() as {
        id: string;
        state: string;
      }[]
    ).map((row) => [row.id, row.state]),
  );

const liveIds = (database: TestDatabase, table: "traces" | "stints" | "quests") =>
  (
    database.query(`SELECT id FROM ${table} WHERE retracted_at IS NULL ORDER BY id`).all() as {
      id: string;
    }[]
  ).map((row) => row.id);

/** Retracts the live traces of `sessionId` through the shared cascade (`w5 eval` selects by date range instead). */
function resetSession(database: TestDatabase, sessionId = "s-inferred") {
  const traces = database
    .query(
      "SELECT id, stint_id, session_id FROM traces WHERE retracted_at IS NULL AND session_id = ?",
    )
    .all(sessionId) as { id: string; stint_id: string; session_id: string | null }[];
  return applyReset(database, planReset(database, traces), { reason: RESET_REASON });
}

/** One more live trace on an existing stint, recorded in `sessionId`. */
function seedTrace(
  database: TestDatabase,
  store: EventStore,
  input: { id: string; stintId: string; sessionId: string; at: string },
) {
  applyIncremental(
    database,
    store.append({
      actor: "backfill",
      kind: "trace.recorded",
      subject: input.id,
      sessionId: input.sessionId,
      payload: {
        stint: input.stintId,
        tool: "claude-code",
        place: "personal/p",
        source: "session",
        started_at: input.at,
        ended_at: input.at,
        who: "hero",
        what: "w",
        why: "w",
        where: "personal/p",
        how: "claude-code",
        confidence: 0.9,
        classified_by: "assistant",
      },
    }),
  );
}

describe("questions about retracted traces", () => {
  function seedQuestions() {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    seedInferred(database, store, "s-inferred");
    for (const state of ["watching", "asked", "expired", "resolved_by_context"] as const) {
      seedQuestion(database, store, {
        id: `Qn-${state}`,
        traceId: "T-s-inferred",
        sessionId: "s-inferred",
        state,
      });
    }
    return { database, store };
  }

  test("a reset closes the unanswered ones with an event and leaves the answered one as it was", () => {
    const { database } = seedQuestions();

    const result = resetSession(database);

    expect(result.questions).toBe(3);
    expect(questionStates(database)).toEqual({
      "Qn-asked": "resolved_by_context",
      "Qn-expired": "resolved_by_context",
      "Qn-resolved_by_context": "resolved_by_context",
      "Qn-watching": "resolved_by_context",
    });
    const closing = database
      .query(
        "SELECT subject, actor, json_extract(payload, '$.reason') AS reason FROM events WHERE kind = 'question.answered' AND actor = 'backfill' ORDER BY subject",
      )
      .all();
    expect(closing).toEqual(
      ["Qn-asked", "Qn-expired", "Qn-watching"].map((subject) => ({
        subject,
        actor: "backfill",
        reason: RESET_REASON,
      })),
    );
  });

  test("the questions table still equals a replay of the events", () => {
    const { database } = seedQuestions();
    resetSession(database);
    const columns = "id, trace_id, session_id, state, answered_by, answer";
    const rows = () => database.query(`SELECT ${columns} FROM questions ORDER BY id`).all();
    const stored = rows();

    rebuildAll(database);

    expect(rows()).toEqual(stored);
  });

  test("tempad review lists none of them, even ones a plain retraction left expired", () => {
    const { database, store } = seedQuestions();
    // Data from before the reset closed questions: the trace is retracted, the question is not.
    append(database, store, "backfill", "retracted", "T-s-inferred", {
      retracts: "T-s-inferred",
      reason: "duplicate backfill window",
    });
    const output: string[] = [];

    runReviewCommand([], {
      database,
      config: makeConfig("/tmp"),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => output.push(line),
      spawn: () => {},
    });

    expect(output.join("\n")).not.toContain("Qn-expired");
  });

  test("the hook neither watches nor asks a question about a retracted trace", () => {
    const { database, store } = seedQuestions();
    append(database, store, "backfill", "retracted", "T-s-inferred", {
      retracts: "T-s-inferred",
      reason: "duplicate backfill window",
    });
    const config = defaultIntentConfig().w5;

    const result = advanceQuestions(store, database, config, {
      sessionId: "s-inferred",
      now: "2026-10-01T00:00:00.000Z",
      turnsSinceLastRun: 50,
      sessionStintMinutes: 60,
      resolvedByContext: [],
    });

    expect(result.asked).toEqual([]);
    expect(result.expired).toEqual([]);
    expect(questionStates(database)["Qn-watching"]).toBe("watching");
    expect(questionStates(database)["Qn-asked"]).toBe("asked");
  });

  test("an asked question about a retracted trace does not reach w5 context", async () => {
    const { database, store } = seedQuestions();
    const live: string[] = [];
    await runW5Command(["context", "--session", "s-inferred"], {
      database,
      config: makeConfig("/tmp"),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => live.push(line),
      spawn: () => {},
    });
    append(database, store, "backfill", "retracted", "T-s-inferred", {
      retracts: "T-s-inferred",
      reason: "duplicate backfill window",
    });
    const output: string[] = [];

    await runW5Command(["context", "--session", "s-inferred"], {
      database,
      config: makeConfig("/tmp"),
      intentConfig: defaultIntentConfig(),
      stdout: (line) => output.push(line),
      spawn: () => {},
    });

    expect(output.join("\n")).not.toContain("Qn-asked");
    // Control: the same question is rendered while its trace is live.
    expect(live.join("\n")).toContain("Qn-asked");
  });

  test("tempad answer refuses a question about a retracted trace and writes nothing", async () => {
    const { database, store } = seedQuestions();
    append(database, store, "backfill", "retracted", "T-s-inferred", {
      retracts: "T-s-inferred",
      reason: "duplicate backfill window",
    });
    const before = counts(database);

    const code = await runIntentCommand(["answer", "Qn-expired", "--belongs"], {
      database,
      config: makeConfig("/tmp"),
      intentConfig: defaultIntentConfig(),
      stdout: () => {},
    });

    expect(code).toBe(1);
    expect(counts(database)).toEqual(before);
    expect(questionStates(database)["Qn-expired"]).toBe("expired");
  });
});

describe("applyReset", () => {
  test("a surviving stint that continued a retracted one loses the link by an event", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    seedInferred(database, store, "s-inferred");
    // A person-recorded session (protected) resumed the inferred stint.
    seedInferred(database, store, "s-manual", { traceActor: "hero" });
    append(database, store, "hook", "stint.opened", "A-next", {
      outcome: "resumed",
      quest: "Q-s-manual",
      continues: "A-s-inferred",
    });
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "trace.relinked",
        subject: "T-s-manual",
        payload: { stint: "A-next", reason: "test" },
      }),
    );
    const continues = () =>
      database.query("SELECT id, continues FROM stints WHERE id = 'A-next'").get();
    expect(continues()).toEqual({ id: "A-next", continues: "A-s-inferred" });

    resetSession(database);

    expect(liveIds(database, "stints")).toContain("A-next");
    expect(continues()).toEqual({ id: "A-next", continues: null });
    expect(
      database.query("SELECT actor FROM events WHERE kind = 'stint.continuation_cleared'").all(),
    ).toEqual([{ actor: "backfill" }]);
    // The projection is a function of the events: a rebuild gives the same stints.
    const stints = () => database.query("SELECT id, continues FROM stints ORDER BY id").all();
    const stored = stints();
    rebuildAll(database);
    expect(stints()).toEqual(stored);
  });

  test("clears the session note of every touched session and no other", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    seedInferred(database, store, "s-inferred");
    seedInferred(database, store, "s-other");
    for (const id of ["s-inferred", "s-other"]) {
      database
        .query(
          "INSERT INTO w5_runs (session_id, last_run_at, last_message_ts, session_note) VALUES (?, ?, ?, 'a note')",
        )
        .run(id, FROM, FROM);
    }
    const plan = planReset(database, [
      { id: "T-s-inferred", stint_id: "A-s-inferred", session_id: "s-inferred" },
    ]);

    applyReset(database, plan, { reason: RESET_REASON });

    expect(
      database.query("SELECT session_id, session_note FROM w5_runs ORDER BY session_id").all(),
    ).toEqual([
      { session_id: "s-inferred", session_note: null },
      { session_id: "s-other", session_note: "a note" },
    ]);
    // The throwaway copy loses the coverage of the touched session only.
    expect(
      database.query("SELECT DISTINCT session_id FROM w5_windows ORDER BY session_id").all(),
    ).toEqual([{ session_id: "s-other" }]);
  });
});

describe("the cascade", () => {
  function seedBase() {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    return { database, store };
  }

  test("a stint with a live trace outside the selection stays, and so does its quest", () => {
    const { database, store } = seedBase();
    seedInferred(database, store, "s-inferred");
    // Another session's live trace sits on the same stint.
    seedSession(database, "s-other", "2026-09-04T16:00:00.000Z");
    seedTrace(database, store, {
      id: "T-shared",
      stintId: "A-s-inferred",
      sessionId: "s-other",
      at: "2026-09-04T16:00:00.000Z",
    });

    const result = resetSession(database);

    expect(result).toMatchObject({ traces: 1, stints: 0, quests: 0 });
    expect(liveIds(database, "traces")).toEqual(["T-shared"]);
    expect(liveIds(database, "stints")).toEqual(["A-s-inferred"]);
    expect(liveIds(database, "quests")).toEqual(["Q-s-inferred"]);
  });

  test("a confirmed quest left with no live stint is kept, an unconfirmed one is retracted", () => {
    const { database, store } = seedBase();
    seedInferred(database, store, "s-confirmed", { confirmedQuest: true });
    seedInferred(database, store, "s-unconfirmed");

    const plan = planReset(
      database,
      database
        .query("SELECT id, stint_id, session_id FROM traces WHERE retracted_at IS NULL")
        .all() as { id: string; stint_id: string; session_id: string | null }[],
    );
    const result = applyReset(database, plan, { reason: RESET_REASON });

    expect(plan.stintIds.sort()).toEqual(["A-s-confirmed", "A-s-unconfirmed"]);
    expect(plan.questIds).toEqual(["Q-s-unconfirmed"]);
    expect(result).toMatchObject({ traces: 2, stints: 2, quests: 1 });
    expect(liveIds(database, "quests")).toEqual(["Q-s-confirmed"]);
  });

  test("resetting again retracts the previous run's rows and never retracts a row twice", () => {
    const { database, store } = seedBase();
    seedInferred(database, store, "s-inferred");

    expect(resetSession(database)).toMatchObject({ traces: 1, stints: 1, quests: 1 });
    // A re-run of the session records a new cohort under the same session.
    append(database, store, "hook", "quest.created", "Q-rerun", {
      owner: { kind: "hero", id: "H1" },
      title: "rerun quest",
      outcome: "o",
      commitment: "focused",
      confirmed: false,
    });
    append(database, store, "hook", "stint.opened", "A-rerun", {
      outcome: "redone work",
      quest: "Q-rerun",
    });
    seedTrace(database, store, {
      id: "T-rerun",
      stintId: "A-rerun",
      sessionId: "s-inferred",
      at: "2026-09-04T15:30:00.000Z",
    });
    const events = () =>
      (database.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

    expect(resetSession(database)).toMatchObject({ traces: 1, stints: 1, quests: 1 });
    const afterSecond = events();
    // Nothing is live any more, so a third reset has nothing to retract and writes nothing.
    expect(resetSession(database)).toEqual({
      traces: 0,
      stints: 0,
      quests: 0,
      questions: 0,
      continuations: 0,
    });
    expect(events()).toBe(afterSecond);
    expect(counts(database)).toMatchObject({ traces: 0, stints: 0, quests: 0 });
    const retractions = database
      .query("SELECT subject, COUNT(*) AS n FROM events WHERE kind = 'retracted' GROUP BY subject")
      .all() as { subject: string; n: number }[];
    expect(retractions.every((row) => row.n === 1)).toBe(true);
    expect(retractions).toHaveLength(6);
  });
});
