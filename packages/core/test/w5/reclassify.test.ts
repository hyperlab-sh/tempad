import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { defaultIntentConfig } from "../../src/intent/config";
import { declareQuest } from "../../src/intent/declarations";
import { applyIncremental, ensureTables, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import type { Classifier, ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";
import { runW5Command } from "../../src/w5/cli";
import {
  BackupError,
  backupDatabase,
  planReclassify,
  RECLASSIFY_REASON,
  reclassify,
} from "../../src/w5/reclassify";

registerAllProjections();

type TestDatabase = ReturnType<typeof openDatabase>;

const FROM = "2026-09-04T00:00:00.000Z";

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
  // A person moved this session's stint to a quest of their own.
  append(database, store, "hero", "stint.assigned", "A-s-assigned", { quest: "Q-s-confirmed" });
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

    const plan = planReclassify(database, { from: FROM });

    expect(plan.sessions.map((session) => session.id).sort()).toEqual([
      "s-confirmed",
      "s-inferred",
    ]);
    expect(
      Object.fromEntries(plan.protectedSessions.map((entry) => [entry.sessionId, entry.reason])),
    ).toEqual({
      "s-declared": "declared",
      "s-assigned": "answered or assigned by a person",
      "s-manual": "not written by w5",
    });
    // s-old ended before --from: not in range at all.
    expect(plan.reset.traces.map((trace) => trace.id).sort()).toEqual([
      "T-s-confirmed",
      "T-s-inferred",
    ]);
    expect(plan.reset.stintIds.sort()).toEqual(["A-s-confirmed", "A-s-inferred"]);
    // The confirmed quest stays, and Q-s-confirmed is also what a person assigned elsewhere.
    expect(plan.reset.questIds).toEqual(["Q-s-inferred"]);
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

    const plan = planReclassify(database, { from: FROM });

    expect(plan.reset.traces.map((trace) => trace.id)).toEqual(["T-s-inferred"]);
    expect(plan.reset.stintIds).toEqual([]);
    expect(plan.reset.questIds).toEqual([]);
  });

  test("an unconfirmed quest a person reworded is kept", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    seedInferred(database, store, "s-inferred");
    append(database, store, "hero", "quest.reworded", "Q-s-inferred", {
      title: "my own wording",
    });

    const plan = planReclassify(database, { from: FROM });

    expect(plan.reset.stintIds).toEqual(["A-s-inferred"]);
    expect(plan.reset.questIds).toEqual([]);
  });

  test("--to is an exclusive bound: a session ending at it is out of range", () => {
    const database = openDatabase(":memory:");
    const store = new EventStore(database);
    ensureTables(database);
    append(database, store, "hero", "hero.created", "H1", { name: "Saulo" });
    seedInferred(database, store, "s-a", { endedAt: "2026-09-04T10:00:00.000Z" });
    seedInferred(database, store, "s-b", { endedAt: "2026-09-04T12:00:00.000Z" });

    const plan = planReclassify(database, { from: FROM, to: "2026-09-04T12:00:00.000Z" });

    expect(plan.sessions.map((session) => session.id)).toEqual(["s-a"]);
  });

  test("a session with nothing live in the database is still in range, with nothing to retract", () => {
    const database = openDatabase(":memory:");
    ensureTables(database);
    seedSession(database, "s-fresh", "2026-09-04T10:00:00.000Z");

    const plan = planReclassify(database, { from: FROM });

    expect(plan.sessions.map((session) => session.id)).toEqual(["s-fresh"]);
    expect(plan.reset.traces).toEqual([]);
  });
});

describe("reclassify", () => {
  test("retracts only the inferred rows by events, classifies only those sessions again, and leaves the rest as it was", async () => {
    const database = openDatabase(":memory:");
    seedWorld(database, new EventStore(database));
    const untouchedBefore = {
      traces: ["T-s-assigned", "T-s-declared", "T-s-manual", "T-s-old"],
      stints: ["A-s-assigned", "A-s-declared", "A-s-manual", "A-s-old"],
    };
    const before = counts(database);
    const classifier = new FreshStintClassifier();
    const logs: string[] = [];

    const result = await reclassify(
      database,
      makeConfig("/tmp"),
      defaultIntentConfig().w5,
      classifier,
      { from: FROM, now: "2026-09-05T00:00:00.000Z", log: (line) => logs.push(line) },
    );

    expect(result.reset).toEqual({ traces: 2, stints: 2, quests: 1 });
    // Only the two reset sessions were classified, once each.
    expect(classifier.sessions.sort()).toEqual(["s-confirmed", "s-inferred"]);
    expect(result.backfill.windowsClassified).toBe(2);

    // The untouched sessions' rows are all still live, byte for byte the same ids.
    for (const id of untouchedBefore.traces) expect(liveIds(database, "traces")).toContain(id);
    for (const id of untouchedBefore.stints) expect(liveIds(database, "stints")).toContain(id);
    // The old inferred rows are retracted, the confirmed quest and the declared quest are not.
    expect(liveIds(database, "traces")).not.toContain("T-s-inferred");
    expect(liveIds(database, "traces")).not.toContain("T-s-confirmed");
    expect(liveIds(database, "quests")).toContain("Q-s-confirmed");
    expect(liveIds(database, "quests")).toContain("Q-s-declared");
    expect(liveIds(database, "quests")).not.toContain("Q-s-inferred");

    // Stint count: 6 live before, the 2 inferred ones retracted and 2 new ones after.
    const after = counts(database);
    expect(before.stints).toBe(6);
    expect(after.stints).toBe(6);
    const live = (outcome: string) =>
      (
        database
          .query("SELECT COUNT(*) AS n FROM stints WHERE outcome = ? AND retracted_at IS NULL")
          .get(outcome) as { n: number }
      ).n;
    expect(live("inferred work")).toBe(4);
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
      "A-s-confirmed",
      "A-s-inferred",
      "Q-s-inferred",
      "T-s-confirmed",
      "T-s-inferred",
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
      { from: FROM, now: "2026-09-05T00:00:00.000Z", log: () => {} },
    );

    const windows = () =>
      database
        .query(
          "SELECT session_id, started_at, ended_at, classified_at FROM w5_windows ORDER BY session_id, started_at, classified_at",
        )
        .all();
    const stored = windows();
    // Six seeded sessions, one window each, plus the two re-run windows of the reset sessions.
    expect(stored.length).toBe(8);
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
          now: "2026-09-05T00:00:00.000Z",
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

      expect(code).toBe(1);
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
      expect(text).toContain("sessions=2 protected=3 would retract traces=2 stints=2 quests=1");
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
      expect(output.join("\n")).toContain("reclassify: sessions=2 protected=3 retracted traces=2");
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
      ["--reclassify", "--from", FROM, "--to", "2026-09-03"],
      "--to must be after --from",
    ],
    [
      "a --to that is no date",
      ["--reclassify", "--from", FROM, "--to", "soon"],
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
