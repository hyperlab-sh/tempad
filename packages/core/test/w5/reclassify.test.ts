import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { declareQuest } from "../../src/intent/declarations";
import { applyIncremental, ensureTables, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import type { Classifier, ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";
import { runReviewCommand, runW5Command } from "../../src/w5/cli";
import { advanceQuestions } from "../../src/w5/questions";
import {
  BackupError,
  backupDatabase,
  planReclassify,
  RECLASSIFY_REASON,
  reclassify,
} from "../../src/w5/reclassify";
import { applyReset, planReset } from "../../src/w5/reset";

registerAllProjections();

type TestDatabase = ReturnType<typeof openDatabase>;

const FROM = "2026-09-04T00:00:00.000Z";
/** Judged long after every seeded session ended, so none is still active. */
const IDLE = { now: "2026-10-01T00:00:00.000Z", activeMinutes: 45 };

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

/** Starts a new stint for every window, as the pre-fix classifier did. */
class FreshStintClassifier implements Classifier {
  public sessions: string[] = [];
  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    this.sessions.push(window.sessionId);
    const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
    const last = window.messages.at(-1)?.ts ?? first;
    return {
      segments: [
        {
          startedAt: first,
          endedAt: last,
          what: "redone work",
          why: "ship",
          belongs: true,
          guess: null,
          matchedQuest: null,
          proposedQuest: null,
          matchedStint: null,
          continuesStint: null,
          newStintReason: "first work of the window",
          isSwitch: false,
          trigger: null,
          confidence: 0.9,
          questions: [],
        },
      ],
      sessionNote: null,
    };
  }
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

function seedWorld(database: TestDatabase, store: EventStore) {
  ensureTables(database);
  append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
  seedInferred(database, store, "s-inferred");
  seedInferred(database, store, "s-inferred-two");
  seedInferred(database, store, "s-confirmed", { confirmedQuest: true });
  seedInferred(database, store, "s-declared");
  declareQuest(store, database, {
    sessionId: "s-declared",
    questId: "Q-s-declared",
    plan: [],
    scope: "session",
    declaredBy: "agent",
    at: "2026-09-04T14:00:00.000Z",
    heroId: "H1",
  });
  seedInferred(database, store, "s-assigned");
  // A person moved this session's stint to another (unconfirmed) quest.
  append(database, store, "hook", "quest.created", "Q-other", {
    owner: { kind: "hero", id: "H1" },
    title: "another quest",
    outcome: "o",
    commitment: "focused",
    confirmed: false,
  });
  append(database, store, "hero", "stint.assigned", "A-s-assigned", { quest: "Q-other" });
  seedInferred(database, store, "s-manual", { traceActor: "hero" });
  seedInferred(database, store, "s-old", { endedAt: "2026-08-01T15:00:00.000Z" });
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

const liveIds = (database: TestDatabase, table: "traces" | "stints" | "quests") =>
  (
    database.query(`SELECT id FROM ${table} WHERE retracted_at IS NULL ORDER BY id`).all() as {
      id: string;
    }[]
  ).map((row) => row.id);

describe("planReclassify", () => {
  test("selects the w5-inferred sessions in range and names why each other one is protected", () => {
    const database = openDatabase(":memory:");
    seedWorld(database, new EventStore(database));

    const plan = planReclassify(database, { from: FROM, ...IDLE });

    expect(plan.sessions.map((session) => session.id).sort()).toEqual([
      "s-inferred",
      "s-inferred-two",
    ]);
    expect(
      Object.fromEntries(plan.protectedSessions.map((entry) => [entry.sessionId, entry.reason])),
    ).toEqual({
      "s-declared": "declared",
      "s-confirmed": "on a confirmed quest",
      "s-assigned": "answered or assigned by a person",
      "s-manual": "not written by w5",
    });
    // s-old ended before --from: not in range at all.
    expect(plan.reset.traces.map((trace) => trace.id).sort()).toEqual([
      "T-s-inferred",
      "T-s-inferred-two",
    ]);
    expect(plan.reset.stintIds.sort()).toEqual(["A-s-inferred", "A-s-inferred-two"]);
    expect(plan.reset.questIds.sort()).toEqual(["Q-s-inferred", "Q-s-inferred-two"]);
  });

  test("a stint with a trace outside the reset stays, and so does its quest", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    seedInferred(database, store, "s-inferred");
    // A protected session's trace lives on the same stint.
    seedSession(database, "s-declared", "2026-09-04T16:00:00.000Z");
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "trace.recorded",
        subject: "T-shared",
        sessionId: "s-declared",
        payload: {
          stint: "A-s-inferred",
          tool: "claude-code",
          place: "personal/p",
          source: "session",
          started_at: "2026-09-04T16:00:00.000Z",
          ended_at: "2026-09-04T16:00:00.000Z",
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
    declareQuest(store, database, {
      sessionId: "s-declared",
      questId: "Q-s-inferred",
      plan: [],
      scope: "session",
      declaredBy: "agent",
      at: "2026-09-04T14:00:00.000Z",
      heroId: "H1",
    });

    const plan = planReclassify(database, { from: FROM, ...IDLE });

    expect(plan.reset.traces.map((trace) => trace.id)).toEqual(["T-s-inferred"]);
    expect(plan.reset.stintIds).toEqual([]);
    expect(plan.reset.questIds).toEqual([]);
  });

  test("a session whose stint sits on an unconfirmed quest a person reworded is protected whole", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    seedInferred(database, store, "s-inferred");
    append(database, store, "hero", "quest.reworded", "Q-s-inferred", {
      title: "my own wording",
    });

    const plan = planReclassify(database, { from: FROM, ...IDLE });

    expect(plan.protectedSessions).toEqual([
      { sessionId: "s-inferred", reason: "on a quest a person changed" },
    ]);
    expect(plan.reset.traces).toEqual([]);
    expect(plan.reset.stintIds).toEqual([]);
  });

  test("--to is an exclusive bound: a session ending at it is out of range", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    seedInferred(database, store, "s-a", { endedAt: "2026-09-04T10:00:00.000Z" });
    seedInferred(database, store, "s-b", { endedAt: "2026-09-04T12:00:00.000Z" });

    const plan = planReclassify(database, { from: FROM, to: "2026-09-04T12:00:00.000Z", ...IDLE });

    expect(plan.sessions.map((session) => session.id)).toEqual(["s-a"]);
  });

  test("a session with nothing live in the database is still in range, with nothing to retract", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database, "s-fresh", "2026-09-04T10:00:00.000Z");

    const plan = planReclassify(database, { from: FROM, ...IDLE });

    expect(plan.sessions.map((session) => session.id)).toEqual(["s-fresh"]);
    expect(plan.reset.traces).toEqual([]);
  });
});

describe("reclassify", () => {
  test("retracts only the inferred rows by events, classifies only those sessions again, and leaves the rest as it was", async () => {
    const database = openDatabase(":memory:");
    seedWorld(database, new EventStore(database));
    const untouchedBefore = {
      traces: ["T-s-assigned", "T-s-confirmed", "T-s-declared", "T-s-manual", "T-s-old"],
      stints: ["A-s-assigned", "A-s-confirmed", "A-s-declared", "A-s-manual", "A-s-old"],
    };
    const before = counts(database);
    const classifier = new FreshStintClassifier();
    const logs: string[] = [];

    const result = await reclassify(
      database,
      makeConfig("/tmp"),
      defaultIntentConfig().w5,
      classifier,
      { from: FROM, ...IDLE, log: (line) => logs.push(line) },
    );

    expect(result.reset).toEqual({
      traces: 2,
      stints: 2,
      quests: 2,
      questions: 0,
      continuations: 0,
    });
    // Only the two reset sessions were classified, once each.
    expect(classifier.sessions.sort()).toEqual(["s-inferred", "s-inferred-two"]);
    expect(result.backfill.windowsClassified).toBe(2);

    // The untouched sessions' rows are all still live, byte for byte the same ids.
    for (const id of untouchedBefore.traces) expect(liveIds(database, "traces")).toContain(id);
    for (const id of untouchedBefore.stints) expect(liveIds(database, "stints")).toContain(id);
    // The old inferred rows are retracted, the confirmed quest and the declared quest are not.
    expect(liveIds(database, "traces")).not.toContain("T-s-inferred");
    expect(liveIds(database, "traces")).not.toContain("T-s-inferred-two");
    expect(liveIds(database, "quests")).toContain("Q-s-confirmed");
    expect(liveIds(database, "quests")).toContain("Q-s-declared");
    expect(liveIds(database, "quests")).not.toContain("Q-s-inferred");
    expect(liveIds(database, "quests")).not.toContain("Q-s-inferred-two");

    // Stint count: 7 live before, the 2 inferred ones retracted and 2 new ones after.
    const after = counts(database);
    expect(before.stints).toBe(7);
    expect(after.stints).toBe(7);
    const live = (outcome: string) =>
      (
        database
          .query("SELECT COUNT(*) AS n FROM stints WHERE outcome = ? AND retracted_at IS NULL")
          .get(outcome) as { n: number }
      ).n;
    expect(live("inferred work")).toBe(5);
    expect(live("redone work")).toBe(2);
    expect(after.traces).toBe(before.traces);

    // History is append-only: every retraction is an event with the reason, none was deleted.
    expect(after.events).toBeGreaterThan(before.events);
    const retractions = database
      .query(
        "SELECT subject, json_extract(payload, '$.reason') AS reason FROM events WHERE kind = 'retracted'",
      )
      .all() as { subject: string; reason: string }[];
    expect(retractions.map((row) => row.subject).sort()).toEqual([
      "A-s-inferred",
      "A-s-inferred-two",
      "Q-s-inferred",
      "Q-s-inferred-two",
      "T-s-inferred",
      "T-s-inferred-two",
    ]);
    expect(new Set(retractions.map((row) => row.reason))).toEqual(new Set([RECLASSIFY_REASON]));
    // No person's event was added or changed.
    expect(database.query("SELECT COUNT(*) AS n FROM events WHERE actor = 'hero'").get()).toEqual({
      n: 3,
    });
  });

  test("the w5_windows projection still equals a replay of the events: coverage is never deleted behind the log", async () => {
    const database = openDatabase(":memory:");
    seedWorld(database, new EventStore(database));

    await reclassify(
      database,
      makeConfig("/tmp"),
      defaultIntentConfig().w5,
      new FreshStintClassifier(),
      { from: FROM, ...IDLE, log: () => {} },
    );

    const windows = () =>
      database
        .query(
          "SELECT session_id, started_at, ended_at, classified_at FROM w5_windows ORDER BY session_id, started_at, classified_at",
        )
        .all();
    const stored = windows();
    // Seven seeded sessions, one window each, plus the two re-run windows of the reset sessions.
    expect(stored.length).toBe(9);
    // A rebuild (what `tempad rebuild` and `scry`'s projection check do) gives the same rows.
    rebuildAll(database);
    expect(windows()).toEqual(stored);
  });

  test("running it twice does not pile up stints: the second run retracts the first run's", async () => {
    const database = openDatabase(":memory:");
    seedWorld(database, new EventStore(database));
    const run = () =>
      reclassify(
        database,
        makeConfig("/tmp"),
        defaultIntentConfig().w5,
        new FreshStintClassifier(),
        {
          from: FROM,
          ...IDLE,
          log: () => {},
        },
      );

    await run();
    const once = counts(database);
    await run();
    const twice = counts(database);

    expect(twice.stints).toBe(once.stints);
    expect(twice.traces).toBe(once.traces);
  });
});

describe("backupDatabase", () => {
  test("writes a copy with every event and refuses to overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-reclassify-"));
    try {
      const database = openDatabase(":memory:");
      seedWorld(database, new EventStore(database));
      const destination = join(dir, "backup.db");

      backupDatabase(database, destination);

      expect(existsSync(destination)).toBe(true);
      expect(() => backupDatabase(database, destination)).toThrow(BackupError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w5 backfill --reclassify", () => {
  async function run(args: string[], seed = true) {
    const dir = mkdtempSync(join(tmpdir(), "tempad-reclassify-cli-"));
    const database = openDatabase(":memory:");
    if (seed) seedWorld(database, new EventStore(database));
    else ensureTables(database);
    const intentConfig = defaultIntentConfig();
    // A classifier that always fails, so a run that classified anything shows up in `failed=`.
    intentConfig.w5.claudeCommand = "/usr/bin/false";
    const output: string[] = [];
    try {
      const code = await runW5Command(["backfill", ...args], {
        database,
        config: makeConfig(dir),
        intentConfig,
        stdout: (line) => output.push(line),
        spawn: () => {},
      });
      return { code, output: output.join("\n"), database, dir };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("without --backup it refuses, prints the VACUUM INTO command and changes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-reclassify-cli-"));
    try {
      const database = openDatabase(":memory:");
      seedWorld(database, new EventStore(database));
      const before = counts(database);
      const output: string[] = [];
      const intentConfig = defaultIntentConfig();
      intentConfig.w5.claudeCommand = "/usr/bin/false";

      const code = await runW5Command(["backfill", "--reclassify", "--from", FROM], {
        database,
        config: makeConfig(dir),
        intentConfig,
        stdout: (line) => output.push(line),
        spawn: () => {},
      });

      expect(code).toBe(2);
      expect(output.join("\n")).toContain("VACUUM INTO");
      expect(output.join("\n")).toContain("--backup");
      expect(counts(database)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--dry-run prints the counts and the protected sessions and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-reclassify-cli-"));
    try {
      const database = openDatabase(":memory:");
      seedWorld(database, new EventStore(database));
      const before = counts(database);
      const output: string[] = [];

      const code = await runW5Command(["backfill", "--reclassify", "--from", FROM, "--dry-run"], {
        database,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: (line) => output.push(line),
        spawn: () => {},
      });

      const text = output.join("\n");
      expect(code).toBe(0);
      expect(text).toContain(
        "sessions=2 protected=4 (on a confirmed quest=1, declared=1, answered or assigned by a person=1, not written by w5=1) would retract traces=2 stints=2 quests=2 and close questions=0 continuations=0",
      );
      expect(text).toContain("protected s-declared (declared)");
      expect(counts(database)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with --backup it writes the backup first, then retracts and classifies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-reclassify-cli-"));
    try {
      const database = openDatabase(":memory:");
      seedWorld(database, new EventStore(database));
      const backup = join(dir, "nested", "before.db");
      const output: string[] = [];
      const intentConfig = defaultIntentConfig();
      intentConfig.w5.claudeCommand = "/usr/bin/false";

      await runW5Command(["backfill", "--reclassify", "--from", FROM, "--backup", backup], {
        database,
        config: makeConfig(dir),
        intentConfig,
        stdout: (line) => output.push(line),
        spawn: () => {},
      });

      expect(existsSync(backup)).toBe(true);
      expect(output[0]).toContain("backup written");
      expect(output.join("\n")).toContain("reclassify: sessions=2 protected=4 retracted traces=2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a backup that cannot be written stops before anything is retracted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-reclassify-cli-"));
    try {
      const database = openDatabase(":memory:");
      seedWorld(database, new EventStore(database));
      const backup = join(dir, "exists.db");
      backupDatabase(database, backup);
      const before = counts(database);
      const output: string[] = [];

      const code = await runW5Command(
        ["backfill", "--reclassify", "--from", FROM, "--backup", backup],
        {
          database,
          config: makeConfig(dir),
          intentConfig: defaultIntentConfig(),
          stdout: (line) => output.push(line),
          spawn: () => {},
        },
      );

      expect(code).toBe(1);
      expect(output.join("\n")).toContain("nothing was changed");
      expect(counts(database)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [name, args, message] of [
    ["--reclassify without --from", ["--reclassify"], "--reclassify needs --from"],
    [
      "--reclassify with --force",
      ["--reclassify", "--from", FROM, "--force"],
      "cannot be combined",
    ],
    [
      "--reclassify with --days",
      ["--reclassify", "--from", FROM, "--days", "3"],
      "cannot be combined",
    ],
    ["--dry-run alone", ["--dry-run"], "--dry-run is only valid with --reclassify"],
    ["--backup alone", ["--backup", "x.db"], "--backup is only valid with --reclassify"],
    ["--to alone", ["--to", FROM], "--to is only valid with --reclassify"],
    [
      "--to before --from",
      ["--reclassify", "--from", FROM, "--to", "2026-09-03", "--dry-run"],
      "--to must be after --from",
    ],
    [
      "a --to that is no date",
      ["--reclassify", "--from", FROM, "--to", "soon", "--dry-run"],
      "--to needs an ISO 8601",
    ],
  ] as const) {
    test(`${name} is a usage error (exit 2) and writes nothing`, async () => {
      const result = await run([...args]);
      expect(result.code).toBe(2);
      expect(result.output).toContain("usage: tempad w5 backfill");
      expect(result.output).toContain(message);
    });
  }
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

  test("a reclassify closes the unanswered ones with an event and leaves the answered one as it was", async () => {
    const { database } = seedQuestions();

    const result = await reclassify(
      database,
      makeConfig("/tmp"),
      defaultIntentConfig().w5,
      new FreshStintClassifier(),
      { from: FROM, ...IDLE, log: () => {} },
    );

    expect(result.reset.questions).toBe(3);
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
        reason: RECLASSIFY_REASON,
      })),
    );
  });

  test("the questions table still equals a replay of the events", async () => {
    const { database } = seedQuestions();
    await reclassify(
      database,
      makeConfig("/tmp"),
      defaultIntentConfig().w5,
      new FreshStintClassifier(),
      { from: FROM, ...IDLE, log: () => {} },
    );
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

describe("protection", () => {
  test("a session that ended within the idle threshold of now is still active, one at the threshold is not", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    const now = "2026-10-01T12:00:00.000Z";
    seedInferred(database, store, "s-live", { endedAt: "2026-10-01T11:16:00.000Z" }); // 44 min
    seedInferred(database, store, "s-idle", { endedAt: "2026-10-01T11:15:00.000Z" }); // 45 min

    const plan = planReclassify(database, { from: FROM, now, activeMinutes: 45 });

    expect(plan.protectedSessions).toEqual([{ sessionId: "s-live", reason: "still active" }]);
    expect(plan.sessions.map((session) => session.id)).toEqual(["s-idle"]);
    expect(plan.reset.traces.map((trace) => trace.id)).toEqual(["T-s-idle"]);
  });

  test("a session whose only person-made event is the answer to one of its questions is protected", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    seedInferred(database, store, "s-inferred");
    seedInferred(database, store, "s-answered");
    seedQuestion(database, store, {
      id: "Qn-answered",
      traceId: "T-s-answered",
      sessionId: "s-answered",
      state: "answered",
    });
    // `tempad answer --belongs` writes nothing else: no event on the trace or the stint.
    expect(
      database
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE actor = 'hero' AND subject IN ('T-s-answered', 'A-s-answered')",
        )
        .get(),
    ).toEqual({ n: 0 });

    const plan = planReclassify(database, { from: FROM, ...IDLE });

    expect(plan.protectedSessions).toEqual([
      { sessionId: "s-answered", reason: "answered or assigned by a person" },
    ]);
    expect(plan.sessions.map((session) => session.id)).toEqual(["s-inferred"]);
  });

  test("an unconfirmed quest only w5 touched does not protect its session", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    seedInferred(database, store, "s-inferred");

    const plan = planReclassify(database, { from: FROM, ...IDLE });

    expect(plan.protectedSessions).toEqual([]);
    expect(plan.reset.questIds).toEqual(["Q-s-inferred"]);
  });
});

describe("applyReset", () => {
  test("a surviving stint that continued a retracted one loses the link by an event", async () => {
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

    await reclassify(
      database,
      makeConfig("/tmp"),
      defaultIntentConfig().w5,
      new FreshStintClassifier(),
      { from: FROM, ...IDLE, log: () => {} },
    );

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

    applyReset(database, plan, { reason: RECLASSIFY_REASON, clearWindowCoverage: false });

    expect(
      database.query("SELECT session_id, session_note FROM w5_runs ORDER BY session_id").all(),
    ).toEqual([
      { session_id: "s-inferred", session_note: null },
      { session_id: "s-other", session_note: "a note" },
    ]);
  });
});

describe("w5 backfill --reclassify, the lock and the flags", () => {
  async function runCli(args: string[], options: { lock?: boolean; backend?: "api" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "tempad-reclassify-lock-"));
    try {
      const database = openDatabase(":memory:");
      seedWorld(database, new EventStore(database));
      const intentConfig = defaultIntentConfig();
      intentConfig.w5.claudeCommand = "/usr/bin/false";
      if (options.backend) intentConfig.w5.backend = options.backend;
      const lockPath = join(dir, "w5.lock");
      // This process's own pid: alive, so the lock is never judged stale.
      if (options.lock) writeFileSync(lockPath, String(process.pid));
      const before = counts(database);
      const output: string[] = [];
      const code = await runW5Command(["backfill", ...args], {
        database,
        config: makeConfig(dir),
        intentConfig,
        stdout: (line) => output.push(line),
        spawn: () => {},
      });
      return {
        code,
        text: output.join("\n"),
        unchanged: JSON.stringify(counts(database)) === JSON.stringify(before),
        lockLeft: existsSync(lockPath),
        dir,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a held runner lock stops it before the backup, exit 1, nothing changed", async () => {
    const run = await runCli(["--reclassify", "--from", FROM, "--backup", "before.db"], {
      lock: true,
    });
    expect(run.code).toBe(1);
    expect(run.text).toContain("runner lock is held");
    expect(run.unchanged).toBe(true);
    // The lock is the other runner's: it is left alone.
    expect(run.lockLeft).toBe(true);
  });

  test("it releases the lock when the run ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-reclassify-lock-"));
    try {
      const database = openDatabase(":memory:");
      seedWorld(database, new EventStore(database));
      const intentConfig = defaultIntentConfig();
      intentConfig.w5.claudeCommand = "/usr/bin/false";

      await runW5Command(
        ["backfill", "--reclassify", "--from", FROM, "--backup", join(dir, "before.db")],
        {
          database,
          config: makeConfig(dir),
          intentConfig,
          stdout: () => {},
          spawn: () => {},
        },
      );

      expect(existsSync(join(dir, "before.db"))).toBe(true);
      expect(existsSync(join(dir, "w5.lock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--dry-run --backup together is a usage error, exit 2, and takes no lock", async () => {
    const run = await runCli(["--reclassify", "--from", FROM, "--dry-run", "--backup", "x.db"]);
    expect(run.code).toBe(2);
    expect(run.text).toContain("usage: tempad w5 backfill");
    expect(run.text).toContain("--dry-run writes nothing");
    expect(run.unchanged).toBe(true);
  });

  test("--dry-run works without ANTHROPIC_API_KEY on the api backend, and a real run says it is missing", async () => {
    const dry = await runCli(["--reclassify", "--from", FROM, "--dry-run"], { backend: "api" });
    expect(dry.code).toBe(0);
    expect(dry.text).toContain("reclassify (dry run)");

    const real = await runCli(["--reclassify", "--from", FROM, "--backup", "before.db"], {
      backend: "api",
    });
    expect(real.code).toBe(1);
    expect(real.text).toContain("ANTHROPIC_API_KEY not set");
    expect(real.unchanged).toBe(true);
  });

  test("--dry-run does not take the lock, so it works while a runner holds it", async () => {
    const run = await runCli(["--reclassify", "--from", FROM, "--dry-run"], { lock: true });
    expect(run.code).toBe(0);
    expect(run.lockLeft).toBe(true);
  });
});
