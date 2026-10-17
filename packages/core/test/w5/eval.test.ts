import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { activeDeclaredQuests } from "../../src/intent/declarations";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import {
  type Classifier,
  type ClassifierResult,
  type ClassifierWindow,
  validateResult,
} from "../../src/w5/classifier";
import {
  InvalidDeclareFileError,
  InvalidEvalRangeError,
  runEval,
  validateEvalRange,
} from "../../src/w5/eval";

registerAllProjections();

class FakeClassifier implements Classifier {
  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
    const last = window.messages.at(-1)?.ts ?? first;
    return {
      segments: [
        {
          startedAt: first,
          endedAt: last,
          what: "work",
          why: "ship",
          belongs: true,
          guess: null,
          // Places the work on whatever the session declared, as a verifier does.
          quest: window.activeQuests[0]?.alias ?? null,
          stint: "new: first work of the window",
          isSwitch: false,
          trigger: null,
          confidence: 0.9,
        },
      ],
      sessionNote: null,
    };
  }
}

function seedSourceDb(path: string): void {
  const database = openDatabase(path);
  ensureTables(database);
  const store = new EventStore(database);
  applyIncremental(
    database,
    store.append({
      actor: "hero",
      kind: "hero.created",
      subject: "H1",
      payload: { name: "Saulo" },
    }),
  );
  database
    .query(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T10:30:00.000Z', 1, 0, '[]', 'host', '2026-09-01T10:30:00.000Z')`,
    )
    .run();
  database
    .query(
      `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
       VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
    )
    .run();
  // A second message five minutes later so the resulting trace meets
  // `stintMinMinutes` (default 5) and is not dismissed.
  database
    .query(
      `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
       VALUES ('m2', 's1', '2026-09-01T10:05:00.000Z', 'user', 0, 'still on it')`,
    )
    .run();
  database.close();
}

/**
 * A hash of everything the database holds (schema and every row of every table), read through
 * a short-lived read-only connection that sees committed WAL frames. It deliberately ignores the
 * file's bytes: the source runs in WAL mode, so the main file also changes when SQLite
 * checkpoints, which a seeding connection does when it is finalized (bun:sqlite defers the real
 * close while a cached statement is alive, so that moment depends on GC and machine load) and
 * which says nothing about whether eval wrote to the source.
 */
function snapshotContent(path: string): string {
  const database = new Database(path, { readonly: true });
  try {
    const objects = database
      .query(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as { type: string; name: string; sql: string | null }[];
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(JSON.stringify(objects));
    for (const object of objects) {
      if (object.type !== "table") continue;
      const rows = database
        .query(`SELECT rowid AS "rowid", * FROM "${object.name}" ORDER BY rowid`)
        .all();
      hasher.update(`${object.name}\n${JSON.stringify(rows)}`);
    }
    return hasher.digest("hex");
  } finally {
    database.close();
  }
}

describe("snapshotContent", () => {
  test("changes when a row is written, and not when SQLite only checkpoints the WAL", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-snapshot-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const before = snapshotContent(sourcePath);
    expect(snapshotContent(sourcePath)).toBe(before);

    const writer = openDatabase(sourcePath);
    try {
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      expect(snapshotContent(sourcePath)).toBe(before);
      writer
        .query(
          "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES ('m3', 's1', '2026-09-01T10:06:00.000Z', 'user', 0, 'x')",
        )
        .run();
    } finally {
      writer.close();
    }
    expect(snapshotContent(sourcePath)).not.toBe(before);
  });
});

describe("validateEvalRange bare-date timezone", () => {
  test("resolves a bare date to the configured TZ's local day", () => {
    const range = validateEvalRange("2026-09-02", "2026-09-02", "America/Sao_Paulo");
    expect(range.from).toBe("2026-09-02T03:00:00.000Z");
    expect(range.to).toBe("2026-09-03T03:00:00.000Z");
  });

  test("resolves a bare date to UTC when TZ is UTC", () => {
    const range = validateEvalRange("2026-09-02", "2026-09-02", "UTC");
    expect(range.from).toBe("2026-09-02T00:00:00.000Z");
    expect(range.to).toBe("2026-09-03T00:00:00.000Z");
  });

  test("defaults to UTC when no timezone is given", () => {
    const range = validateEvalRange("2026-09-02", "2026-09-02");
    expect(range.from).toBe("2026-09-02T00:00:00.000Z");
    expect(range.to).toBe("2026-09-03T00:00:00.000Z");
  });

  test("leaves a full ISO input untouched regardless of timezone", () => {
    const range = validateEvalRange(
      "2026-09-02T09:00:00.000Z",
      "2026-09-02T18:30:00.000Z",
      "America/Sao_Paulo",
    );
    expect(range.from).toBe("2026-09-02T09:00:00.000Z");
    expect(range.to).toBe("2026-09-02T18:30:00.000Z");
  });
});

describe("w5 eval", () => {
  test("copies the source db, force-reclassifies the range, and reports metrics without touching the source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const sourceBefore = snapshotContent(sourcePath);

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    expect(metrics.traces).toBe(1);
    expect(metrics.stints).toBe(1);
    expect(metrics.ratio).toBe(1);
    expect(metrics.continuesLinks).toBe(0);
    expect(metrics.doubts).toBe(0);
    expect(metrics.sessionsDeclared).toBe(0);
    expect(metrics.sessionsInferred).toBe(1);
    expect(metrics.sample.length).toBe(1);
    expect(metrics.sample[0]).toMatchObject({
      what: "work",
      why: "ship",
      sessionTitle: "p session",
    });
    expect(metrics.copiedDbPath).not.toBe(sourcePath);

    expect(snapshotContent(sourcePath)).toBe(sourceBefore);
  });

  test("never opens the source database for writing even when the eval range excludes all sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-empty-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const sourceBefore = snapshotContent(sourcePath);

    const metrics = await runEval({
      from: "2026-01-01",
      to: "2026-01-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-01-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    expect(metrics.traces).toBe(0);
    expect(metrics.stints).toBe(0);
    expect(metrics.ratio).toBe(0);
    expect(metrics.medianStintDurationMinutes).toBe(0);
    expect(metrics.sample.length).toBe(0);

    expect(snapshotContent(sourcePath)).toBe(sourceBefore);
  });

  test("the stints/traces ratio excludes dismissed stints from the denominator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-dismissed-"));
    const sourcePath = join(dir, "source.db");
    const database = openDatabase(sourcePath);
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: "H1",
        payload: { name: "Saulo" },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', 2, 0, '[]', 'host', '2026-09-01T11:00:00.000Z')`,
      )
      .run();
    // Two messages an hour apart, well past a chunk boundary (throttleMinutes *
    // 3 = 30 minutes): each becomes its own window with a single-message, 0-minute
    // segment. The second window's own closeIdleStints call idle-closes the
    // first window's stint, whose live trace minutes (0) are below the default
    // 5-minute stintMinMinutes, so it is dismissed.
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m2', 's1', '2026-09-01T11:00:00.000Z', 'user', 0, 'do a second thing')`,
      )
      .run();
    database.close();

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    expect(metrics.traces).toBe(2);
    expect(metrics.stints).toBe(1);
    expect(metrics.ratio).toBe(0.5);
  });

  test("rejects a malformed --from/--to before touching the source database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-bad-range-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);

    await expect(
      runEval({
        from: "not-a-date",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(InvalidEvalRangeError);

    await expect(
      runEval({
        from: "2026-09-02",
        to: "not-a-date",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(InvalidEvalRangeError);

    await expect(
      runEval({
        from: "2026-09-05",
        to: "2026-09-01",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-05T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(InvalidEvalRangeError);
  });

  test("copies committed rows even when the source db's WAL sidecar has not been checkpointed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-wal-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: "H1",
        payload: { name: "Saulo" },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T10:30:00.000Z', 1, 0, '[]', 'host', '2026-09-01T10:30:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    // A second message five minutes later so the resulting trace meets
    // `stintMinMinutes` (default 5) and is not dismissed.
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m2', 's1', '2026-09-01T10:05:00.000Z', 'user', 0, 'still on it')`,
      )
      .run();
    // Leave the source connection open (WAL mode, from openDatabase) rather than
    // closing/checkpointing it -- this is the state a real tempad.db is in while
    // `tempad w5 run` holds it open.

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    database.close();

    expect(metrics.traces).toBe(1);
    expect(metrics.stints).toBe(1);
  });

  test("reports a real quest conflict count from the run summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-conflict-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: "H1",
        payload: { name: "Saulo" },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T15:40:00.000Z', 1, 0, '[]', 'host', '2026-09-01T15:40:00.000Z')`,
      )
      .run();
    // Two message groups more than throttleMinutes*3 = 30 minutes apart, so
    // backfill splits them into two chunks classified one after another;
    // less than activityIdleMinutes = 45 apart, so chunk 1's stint is
    // still open when chunk 2 is classified.
    for (const [index, ts] of ["2026-09-01T10:00:00.000Z", "2026-09-01T10:40:00.000Z"].entries()) {
      database
        .query(
          `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
           VALUES (?, 's1', ?, 'user', 0, 'do the thing')`,
        )
        .run(`m${index}`, ts);
    }
    database.close();

    /**
     * Chunk 1 proposes a new quest for a new stint. Chunk 2 reuses that
     * stint via `matchedStint` but names a *different, non-null*
     * `matchedQuest` -- `apply.ts` never reassigns a matched stint's quest,
     * so this is exactly a quest conflict, counted and returned in the run
     * summary. `matchedQuest: null` would instead mean "no opinion" and count
     * nothing; that case is covered by its own test below.
     */
    class ConflictingClassifier implements Classifier {
      private chunk = 0;

      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        this.chunk += 1;
        const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;

        if (this.chunk === 1) {
          return {
            segments: [
              {
                startedAt: first,
                endedAt: last,
                what: "work",
                why: "ship",
                belongs: true,
                guess: null,
                matchedQuest: null,
                proposedQuest: { title: "Q1", outcome: "ship it", commitment: "personal" },
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

        const open = window.sessionOpenStints.at(-1);
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "more work",
              why: "ship",
              belongs: true,
              guess: null,
              matchedQuest: "Q-OTHER",
              proposedQuest: null,
              matchedStint: open?.stintId ?? null,
              continuesStint: null,
              newStintReason: open ? null : "nothing open to reuse",
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

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new ConflictingClassifier(),
      log: () => {},
    });

    expect(metrics.doubts).toBe(1);
  });

  test("matchedQuest null on a matched stint is no opinion, not a conflict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-no-opinion-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: "H1",
        payload: { name: "Saulo" },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T15:40:00.000Z', 1, 0, '[]', 'host', '2026-09-01T15:40:00.000Z')`,
      )
      .run();
    for (const [index, ts] of ["2026-09-01T10:00:00.000Z", "2026-09-01T10:40:00.000Z"].entries()) {
      database
        .query(
          `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
           VALUES (?, 's1', ?, 'user', 0, 'do the thing')`,
        )
        .run(`m${index}`, ts);
    }
    database.close();

    /** Same shape as the conflict case, but chunk 2 offers no quest opinion. */
    class SilentQuestClassifier implements Classifier {
      private chunk = 0;

      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        this.chunk += 1;
        const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;

        if (this.chunk === 1) {
          return {
            segments: [
              {
                startedAt: first,
                endedAt: last,
                what: "work",
                why: "ship",
                belongs: true,
                guess: null,
                matchedQuest: null,
                proposedQuest: { title: "Q1", outcome: "ship it", commitment: "personal" },
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

        const open = window.sessionOpenStints.at(-1);
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "more work",
              why: "ship",
              belongs: true,
              guess: null,
              matchedQuest: null,
              proposedQuest: null,
              matchedStint: open?.stintId ?? null,
              continuesStint: null,
              newStintReason: open ? null : "nothing open to reuse",
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

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new SilentQuestClassifier(),
      log: () => {},
    });

    expect(metrics.doubts).toBe(0);
  });

  test("selector repairs are counted and surfaced in the metrics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-selector-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: "H1",
        payload: { name: "Saulo" },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T15:40:00.000Z', 1, 0, '[]', 'host', '2026-09-01T15:40:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m0', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    database.close();

    /**
     * Returns raw JSON through `validateResult`, the way a real backend does, so
     * the repair happens where it would in production: a segment naming no
     * selector at all.
     */
    class SelectorlessClassifier implements Classifier {
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        return validateResult(
          {
            segments: [
              {
                startedAt: first,
                endedAt: last,
                what: "work",
                why: "ship",
                belongs: true,
                confidence: 0.9,
                isSwitch: false,
              },
            ],
            sessionNote: null,
          },
          window,
        );
      }
    }

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new SelectorlessClassifier(),
      log: () => {},
    });

    expect(metrics.selectorDefaulted).toBe(1);
    expect(metrics.selectorAmbiguous).toBe(0);
    expect(metrics.traces).toBe(1);
  });

  test("resets an old cohort inside the range before rerunning, leaves rows outside the range untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-reset-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: "H1",
        payload: { name: "Saulo" },
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "quest.created",
        subject: "Q_IN",
        payload: {
          owner: { kind: "hero", id: "H1" },
          title: "old in-range quest",
          outcome: "obj",
          commitment: "focused",
          confirmed: false,
        },
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "stint.opened",
        subject: "A_IN",
        payload: { outcome: "old in-range work", quest: "Q_IN" },
        at: "2026-09-01T09:00:00.000Z",
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "trace.recorded",
        subject: "T_IN",
        sessionId: "s1",
        payload: {
          stint: "A_IN",
          tool: "claude-code",
          place: "p",
          source: "session",
          started_at: "2026-09-01T09:00:00.000Z",
          ended_at: "2026-09-01T09:10:00.000Z",
          who: "hero",
          what: "old work",
          why: "old",
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
        actor: "hook",
        kind: "quest.created",
        subject: "Q_OUT",
        payload: {
          owner: { kind: "hero", id: "H1" },
          title: "old out-of-range quest",
          outcome: "obj",
          commitment: "focused",
          confirmed: false,
        },
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "stint.opened",
        subject: "A_OUT",
        payload: { outcome: "old out-of-range work", quest: "Q_OUT" },
        at: "2026-08-01T09:00:00.000Z",
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "trace.recorded",
        subject: "T_OUT",
        sessionId: "s2",
        payload: {
          stint: "A_OUT",
          tool: "claude-code",
          place: "p",
          source: "session",
          started_at: "2026-08-01T09:00:00.000Z",
          ended_at: "2026-08-01T09:10:00.000Z",
          who: "hero",
          what: "old work",
          why: "old",
          where: "personal/p",
          how: "claude-code",
          confidence: 0.9,
          classified_by: "assistant",
        },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T10:30:00.000Z', 1, 0, '[]', 'host', '2026-09-01T10:30:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    // A second message five minutes later so the resulting trace meets
    // `stintMinMinutes` (default 5) and is not dismissed.
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m2', 's1', '2026-09-01T10:05:00.000Z', 'user', 0, 'still on it')`,
      )
      .run();
    database
      .query(
        "INSERT INTO w5_runs (session_id, last_run_at, last_message_ts, session_note) VALUES ('s1', '2026-09-01T09:10:00.000Z', '2026-09-01T09:10:00.000Z', 'touched note')",
      )
      .run();
    database
      .query(
        "INSERT INTO w5_runs (session_id, last_run_at, last_message_ts, session_note) VALUES ('s2', '2026-08-01T09:10:00.000Z', '2026-08-01T09:10:00.000Z', 'untouched note')",
      )
      .run();
    database
      .query(
        "INSERT INTO w5_windows (session_id, started_at, ended_at, classified_at) VALUES ('s1', '2026-09-01T09:00:00.000Z', '2026-09-01T09:10:00.000Z', '2026-09-01T09:10:00.000Z')",
      )
      .run();
    database
      .query(
        "INSERT INTO w5_windows (session_id, started_at, ended_at, classified_at) VALUES ('s2', '2026-08-01T09:00:00.000Z', '2026-08-01T09:10:00.000Z', '2026-08-01T09:10:00.000Z')",
      )
      .run();
    database.close();

    const sourceBefore = snapshotContent(sourcePath);

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    expect(snapshotContent(sourcePath)).toBe(sourceBefore);

    expect(metrics.resetTraces).toBe(1);
    expect(metrics.resetStints).toBe(1);
    expect(metrics.resetQuests).toBe(1);

    const copied = openDatabase(metrics.copiedDbPath);
    const inRange = copied.query("SELECT retracted_at FROM traces WHERE id = 'T_IN'").get() as {
      retracted_at: string | null;
    };
    expect(inRange.retracted_at).not.toBeNull();
    const outOfRange = copied.query("SELECT retracted_at FROM traces WHERE id = 'T_OUT'").get() as {
      retracted_at: string | null;
    };
    expect(outOfRange.retracted_at).toBeNull();

    const questIn = copied.query("SELECT retracted_at FROM quests WHERE id = 'Q_IN'").get() as {
      retracted_at: string | null;
    };
    expect(questIn.retracted_at).not.toBeNull();
    const questOut = copied.query("SELECT retracted_at FROM quests WHERE id = 'Q_OUT'").get() as {
      retracted_at: string | null;
    };
    expect(questOut.retracted_at).toBeNull();

    const runS1 = copied
      .query("SELECT session_note FROM w5_runs WHERE session_id = 's1'")
      .get() as { session_note: string | null };
    expect(runS1.session_note).toBeNull();
    const runS2 = copied
      .query("SELECT session_note FROM w5_runs WHERE session_id = 's2'")
      .get() as { session_note: string | null };
    expect(runS2.session_note).toBe("untouched note");

    // The old w5_windows row for s1 (classified_at "2026-09-01T09:10:00.000Z") is
    // deleted by the reset; the rerun's backfill then inserts its own fresh row for
    // s1, so the reset's deletion is checked by that old row's absence, not by count.
    const oldWindowS1 = copied
      .query(
        "SELECT COUNT(*) as n FROM w5_windows WHERE session_id = 's1' AND classified_at = '2026-09-01T09:10:00.000Z'",
      )
      .get() as { n: number };
    expect(oldWindowS1.n).toBe(0);
    const windowsS2 = copied
      .query("SELECT COUNT(*) as n FROM w5_windows WHERE session_id = 's2'")
      .get() as { n: number };
    expect(windowsS2.n).toBe(1);

    copied.close();

    // Only the rerun's rows count toward the metrics, not the reset old cohort.
    expect(metrics.traces).toBe(1);
    expect(metrics.stints).toBe(1);
  });

  test("a bare --to date includes the whole to day, not just its start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-to-day-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: "H1",
        payload: { name: "Saulo" },
      }),
    );
    // Old cohort dated later in the day of --to (2026-09-02) -- a bare
    // "2026-09-02" upper bound compared as TEXT with `<=` against this
    // timestamp would previously evaluate false, leaving this old cohort
    // out of the reset entirely.
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "stint.opened",
        subject: "A_LATE",
        payload: { outcome: "old late-in-day work" },
        at: "2026-09-02T09:00:00.000Z",
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "trace.recorded",
        subject: "T_LATE",
        sessionId: "s1",
        payload: {
          stint: "A_LATE",
          tool: "claude-code",
          place: "p",
          source: "session",
          started_at: "2026-09-02T09:00:00.000Z",
          ended_at: "2026-09-02T09:10:00.000Z",
          who: "hero",
          what: "old work",
          why: "old",
          where: "personal/p",
          how: "claude-code",
          confidence: 0.9,
          classified_by: "assistant",
        },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-02T09:00:00.000Z', '2026-09-02T09:30:00.000Z', 1, 0, '[]', 'host', '2026-09-02T09:30:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's1', '2026-09-02T09:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    // A second message five minutes later so the resulting trace meets
    // `stintMinMinutes` (default 5) and is not dismissed.
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m2', 's1', '2026-09-02T09:05:00.000Z', 'user', 0, 'still on it')`,
      )
      .run();
    database.close();

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-03T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    // The late-in-day old cohort was reset and its trace's window reclassified.
    expect(metrics.resetTraces).toBe(1);
    expect(metrics.resetStints).toBe(1);
    expect(metrics.traces).toBe(1);
    expect(metrics.stints).toBe(1);

    const copied = openDatabase(metrics.copiedDbPath);
    const oldTrace = copied.query("SELECT retracted_at FROM traces WHERE id = 'T_LATE'").get() as {
      retracted_at: string | null;
    };
    expect(oldTrace.retracted_at).not.toBeNull();
    copied.close();
  });

  test("--declare applies declarations to the copy before rerunning, producing doubts/doubtsAnswered/tracesUnattributed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-declare-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Ship p", outcome: "ship it", commitment: "personal" },
        },
      ]),
    );

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
      declareFile,
    });

    expect(metrics.doubts).toBeDefined();
    expect(metrics.doubtsAnswered).toBe(0);
    expect(metrics.tracesUnattributed).toBe(0);

    const copied = openDatabase(metrics.copiedDbPath);
    const quest = copied
      .query("SELECT title, origin_kind as originKind FROM quests WHERE title = 'Ship p'")
      .get() as { title: string; originKind: string } | null;
    expect(quest).not.toBeNull();
    expect(quest?.originKind).toBe("declared");
    copied.close();
  });

  test("doubtsAnswered excludes an answered belongs/declare question sitting on a retracted trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-doubts-retracted-"));
    const sourcePath = join(dir, "source.db");
    const database = openDatabase(sourcePath);
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: "H1",
        payload: { name: "Saulo" },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T10:30:00.000Z', 1, 0, '[]', 'host', '2026-09-01T10:30:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    // A pre-existing stint/trace/answered-belongs-question from an earlier
    // eval/backfill run of this same range -- resetRange (via runEval below)
    // retracts this trace as old-cohort, and doubtsAnswered must not count
    // its question once the trace it's tied to is gone.
    database.exec(
      `INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, revision)
       VALUES ('stint-old', NULL, 'old work', '2026-09-01T10:00:00.000Z', '2026-09-01T10:10:00.000Z', 1)`,
    );
    database.exec(
      `INSERT INTO traces (id, stint_id, tool, place, source, source_ref, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('trace-old', 'stint-old', 'edit', '/w/p', 'session', 's1', '2026-09-01T10:00:00.000Z', '2026-09-01T10:10:00.000Z', 'H1', 'old edit', 'old reason', '/w/p', 'assistant edit', 0.9, 'model', 's1', '2026-09-01T10:10:00.000Z')`,
    );
    database.exec(
      `INSERT INTO questions (id, trace_id, session_id, text, kind, state, asked_at, answered_at, answer, answered_by, turns_watched)
       VALUES ('question-old', 'trace-old', 's1', 'does this belong?', 'belongs', 'answered', '2026-09-01T10:05:00.000Z', '2026-09-01T10:06:00.000Z', 'yes', 'hero', 1)`,
    );
    database.close();

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    expect(metrics.resetTraces).toBeGreaterThan(0);
    expect(metrics.doubtsAnswered).toBe(0);
  });

  test("doubts_recorded counts traces with a non-null doubt, auditable even without asking", async () => {
    class DoubtingClassifier implements Classifier {
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "work",
              why: "ship",
              belongs: false,
              guess: "a side errand",
              quest: null,
              stint: "new: an unrelated errand",
              isSwitch: false,
              trigger: null,
              confidence: 0.9,
            },
          ],
          sessionNote: null,
        };
      }
    }

    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-doubts-recorded-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Ship p", outcome: "ship it", commitment: "personal" },
        },
      ]),
    );

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new DoubtingClassifier(),
      log: () => {},
      declareFile,
    });

    expect(metrics.doubtsRecorded).toBeGreaterThan(0);
    expect(metrics.doubtsRecorded).toBe(metrics.doubts);
  });

  test("doubts_recorded excludes a trace whose stint has since been dismissed, same filter as tempad review", async () => {
    // Two messages far enough apart (> stintIdleMinutes, and > the 30-minute
    // chunk window) that backfill classifies them as two separate windows of
    // the same session: the first window's doubted segment is short (under
    // stintMinMinutes), so by the time the second window starts,
    // `closeIdleStints` closes and dismisses its stint below the minimum --
    // exactly the "dismissed after carrying a doubt" scenario `tempad review`
    // already excludes.
    class DoubtThenDismissClassifier implements Classifier {
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "work",
              why: "ship",
              belongs: false,
              guess: "a side errand",
              quest: null,
              stint: "new: an unrelated errand",
              isSwitch: false,
              trigger: null,
              confidence: 0.9,
            },
          ],
          sessionNote: null,
        };
      }
    }

    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-doubts-dismissed-"));
    const sourcePath = join(dir, "source.db");
    const database = openDatabase(sourcePath);
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: "H1",
        payload: { name: "Saulo" },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T12:00:00.000Z', 2, 0, '[]', 'host', '2026-09-01T12:00:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do a short errand')`,
      )
      .run();
    // One hour later: past both the 30-minute chunk window and the default
    // 45-minute stint idle threshold, so this lands in a second window and
    // `closeIdleStints` closes/dismisses the first window's short stint first.
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m2', 's1', '2026-09-01T11:00:00.000Z', 'user', 0, 'a second unrelated errand')`,
      )
      .run();
    database.close();

    // Declared mode is what writes `belongs`/`guess` onto the trace at all
    // (`traces.doubt` stays null in inference mode); a session that never
    // declares falls back to inference during backfill.
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Ship p", outcome: "ship it", commitment: "personal" },
        },
      ]),
    );

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new DoubtThenDismissClassifier(),
      log: () => {},
      declareFile,
    });

    const copied = openDatabase(metrics.copiedDbPath);
    const dismissedDoubtedCount = (
      copied
        .query(
          `SELECT COUNT(*) as count FROM traces t
           JOIN stints s ON s.id = t.stint_id
           WHERE t.doubt IS NOT NULL AND t.retracted_at IS NULL AND s.dismissed_at IS NOT NULL`,
        )
        .get() as { count: number }
    ).count;
    const liveDoubtedCount = (
      copied
        .query(
          "SELECT COUNT(*) as count FROM traces WHERE doubt IS NOT NULL AND retracted_at IS NULL",
        )
        .get() as { count: number }
    ).count;
    copied.close();

    // The scenario must actually produce a dismissed doubted trace, or this
    // test would pass vacuously.
    expect(dismissedDoubtedCount).toBeGreaterThan(0);
    // doubts_recorded excludes it, exactly like tempad review's listing does:
    // the count is strictly less than the raw (undismissed-blind) trace count.
    expect(metrics.doubtsRecorded).toBe(liveDoubtedCount - dismissedDoubtedCount);
    expect(metrics.doubtsRecorded).toBeLessThan(liveDoubtedCount);
  });

  test("--declare leaves traces unattributed when the session never declares in that window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-undeclared-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    expect(metrics.tracesUnattributed).toBeGreaterThan(0);
  });

  test("a missing --declare file exits with InvalidDeclareFileError, not a raw crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-declare-missing-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile: join(dir, "does-not-exist.json"),
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });

  test("a malformed --declare file (bad JSON, or a non-array top level) exits with InvalidDeclareFileError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-declare-malformed-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);

    const badJsonFile = join(dir, "bad.json");
    writeFileSync(badJsonFile, "{ not valid json ]");

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile: badJsonFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);

    const notArrayFile = join(dir, "not-array.json");
    writeFileSync(notArrayFile, JSON.stringify({ session_id: "s1" }));

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:01.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile: notArrayFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });

  test("a declaration for a session absent from the copy is logged and counted in declarationsSkipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-declare-unknown-session-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "does-not-exist",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Ship p", outcome: "ship it", commitment: "personal" },
        },
      ]),
    );

    const lines: string[] = [];
    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: (line) => lines.push(line),
      declareFile,
    });

    expect(metrics.declarationsSkipped).toBe(1);
    expect(lines.some((line) => line.includes("does-not-exist"))).toBe(true);
  });

  test("the sampled stints do not carry the title of a retracted quest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-retracted-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Mistaken quest", outcome: "oops", commitment: "personal" },
        },
      ]),
    );

    // The classifier runs against the eval copy, so retracting the declared
    // quest from inside it leaves the stint the segment opens pointing at a
    // retracted quest: exactly what the sample query must not name.
    class RetractingClassifier extends FakeClassifier {
      override async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        const result = await super.classify(window);
        const copyName = readdirSync(dir).find(
          (name) => name.startsWith("eval-") && name.endsWith(".db"),
        );
        const copy = openDatabase(join(dir, copyName as string));
        const quest = copy.query("SELECT id FROM quests WHERE title = 'Mistaken quest'").get() as {
          id: string;
        };
        applyIncremental(
          copy,
          new EventStore(copy).append({
            actor: "hero",
            kind: "retracted",
            subject: quest.id,
            payload: { retracts: quest.id, reason: "mistake" },
          }),
        );
        copy.close();
        return result;
      }
    }

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new RetractingClassifier(),
      log: () => {},
      declareFile,
    });

    const copied = openDatabase(metrics.copiedDbPath);
    const stint = copied.query("SELECT quest_id AS questId FROM stints").get() as {
      questId: string | null;
    };
    const retractedQuest = copied
      .query("SELECT retracted_at AS at FROM quests WHERE id = ?")
      .get(stint.questId) as { at: string | null };
    copied.close();
    // Control: the stint really does sit on the retracted quest.
    expect(retractedQuest.at).not.toBeNull();
    expect(metrics.sample.length).toBe(1);
    expect(metrics.sample[0]?.questTitle).toBeNull();
  });

  test("attributeNonClaudeEvidence's tie rule ('latest declaration wins') applies through --declare when two sessions overlap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-tie-"));
    const sourcePath = join(dir, "source.db");
    const database = openDatabase(sourcePath);
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: "H1",
        payload: { name: "Saulo" },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES
         ('s-early', '/c', 'p', '/c/p/s-early.jsonl', '/w/p', 'personal', 'p', 'early', 'main', '2026-09-01T09:00:00.000Z', '2026-09-01T12:00:00.000Z', 1, 0, '[]', 'host', '2026-09-01T12:00:00.000Z'),
         ('s-late', '/c', 'p', '/c/p/s-late.jsonl', '/w/p', 'personal', 'p', 'late', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T12:00:00.000Z', 1, 0, '[]', 'host', '2026-09-01T12:00:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's-early', '2026-09-01T09:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    database.close();

    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s-early",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Early quest", outcome: "early", commitment: "personal" },
        },
        {
          session_id: "s-late",
          at: "2026-09-01T10:00:00.000Z",
          new: { title: "Late quest", outcome: "late", commitment: "personal" },
        },
      ]),
    );

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
      declareFile,
    });

    const { attributeNonClaudeEvidence } = await import("../../src/report/intent-queries");
    const copied = openDatabase(metrics.copiedDbPath);
    copied
      .query(
        `INSERT INTO gh_repos (full_name, org, is_personal, project) VALUES ('personal/p', 'personal', 1, 'p')`,
      )
      .run();
    copied
      .query(
        `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, files_changed, insertions, deletions)
         VALUES ('cccccccc0000000000000000000000000000000', 'personal/p', '["main"]', 'A', 'a@example.com', '2026-09-01T11:00:00.000Z', '2026-09-01T11:00:00.000Z', 'tie test', 1, 1, 1)`,
      )
      .run();

    const rows = attributeNonClaudeEvidence(copied, {
      from: "2026-09-01",
      to: "2026-09-02",
      timeZone: "UTC",
    });
    const row = rows.find((r) => r.id === "cccccccc0000000000000000000000000000000");
    expect(row?.questTitle).toBe("Late quest");
    copied.close();
  });

  test("--declare passes through scope/parent_session_id/declared_by, and resolves new_ref/quest_ref across entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-refs-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Ship p", outcome: "ship it", commitment: "personal" },
          new_ref: "main-quest",
        },
        {
          session_id: "s1-sub",
          at: "2026-09-01T09:05:00.000Z",
          quest_ref: "main-quest",
          scope: "subagent",
          parent_session_id: "s1",
          declared_by: "agent",
        },
      ]),
    );

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
      declareFile,
    });

    const { currentDeclaredQuestForSubagent } = await import("../../src/intent/declarations");
    const copied = openDatabase(metrics.copiedDbPath);
    const declared = currentDeclaredQuestForSubagent(copied, {
      sessionId: "s1-sub",
      parentSessionId: "s1",
      at: "2026-09-01T09:10:00.000Z",
    });
    expect(declared?.title).toBe("Ship p");
    copied.close();
  });

  test("--declare rejects an unknown quest_ref with InvalidDeclareFileError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-refs-unknown-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          quest_ref: "does-not-exist",
        },
      ]),
    );

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });

  test("--declare rejects an entry with none of quest/quest_ref/new", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-refs-none-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([{ session_id: "s1", at: "2026-09-01T09:00:00.000Z" }]),
    );

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });

  test("--declare rejects an entry with more than one of quest/quest_ref/new", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-refs-multiple-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          quest: "some-quest-id",
          new: { title: "Ship p", outcome: "ship it", commitment: "personal" },
        },
      ]),
    );

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });

  test("--declare rejects new_ref given without new", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-refs-orphan-newref-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          quest: "some-quest-id",
          new_ref: "orphan",
        },
      ]),
    );

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });

  test("--declare's new.plan and top-level plan populate the declared quest's plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-declare-plan-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          new: {
            title: "Ship p",
            outcome: "ship it",
            commitment: "personal",
            plan: ["Refactor the window builder and ship it as a PR"],
          },
        },
      ]),
    );

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
      declareFile,
    });

    const copied = openDatabase(metrics.copiedDbPath);
    const active = activeDeclaredQuests(copied, {
      sessionId: "s1",
      at: "2026-09-01T09:30:00.000Z",
    });
    expect(active.length).toBe(1);
    expect(active[0]?.plan).toEqual(["Refactor the window builder and ship it as a PR"]);
    copied.close();
  });

  test("--declare's top-level plan amends an existing quest's plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-declare-plan-amend-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Ship p", outcome: "ship it", commitment: "personal" },
          new_ref: "p",
        },
        {
          session_id: "s1",
          at: "2026-09-01T09:15:00.000Z",
          quest_ref: "p",
          plan: ["Refactor the window builder and ship it as a PR"],
        },
      ]),
    );

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
      declareFile,
    });

    const copied = openDatabase(metrics.copiedDbPath);
    const active = activeDeclaredQuests(copied, {
      sessionId: "s1",
      at: "2026-09-01T09:30:00.000Z",
    });
    expect(active.length).toBe(1);
    expect(active[0]?.plan).toEqual(["Refactor the window builder and ship it as a PR"]);
    copied.close();
  });

  test("eval metrics report stintsDismissed, planStintsHit, and stintsNew", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-plan-metrics-"));
    const sourcePath = join(dir, "source.db");
    const database = openDatabase(sourcePath);
    ensureTables(database);
    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "hero.created",
        subject: "H1",
        payload: { name: "Saulo" },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T13:00:00.000Z', 4, 0, '[]', 'host', '2026-09-01T13:00:00.000Z')`,
      )
      .run();
    // m1 alone, an hour before m2 (past the default 45-minute
    // stintIdleMinutes and the 30-minute chunk boundary): its stint is
    // idle-closed with 0 live trace minutes, below the default 5-minute
    // stintMinMinutes, so it is dismissed (stintsDismissed) -- and, having
    // no plan_index, also counts toward stintsNew. m2/m3 are six minutes
    // apart within the same window and both land on the declared plan item,
    // giving that stint 6 live trace minutes, clear of the minimum, so it
    // survives (planStintsHit counts the resulting trace). m4, another hour
    // later, opens a plain new stint outside the plan, still open at query
    // time -- it also has no plan_index, so it counts toward stintsNew too.
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m2', 's1', '2026-09-01T11:00:00.000Z', 'user', 0, 'work the plan item')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m3', 's1', '2026-09-01T11:06:00.000Z', 'user', 0, 'still working the plan item')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m4', 's1', '2026-09-01T12:05:00.000Z', 'user', 0, 'something unplanned')`,
      )
      .run();
    database.close();

    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          new: {
            title: "Ship p",
            outcome: "ship it",
            commitment: "personal",
            plan: ["Refactor the window builder and ship it as a PR"],
          },
        },
      ]),
    );

    class PlanGrainClassifier implements Classifier {
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        const alias = window.activeQuests[0]?.alias ?? null;
        const stint =
          first === "2026-09-01T11:00:00.000Z"
            ? "P1.1"
            : first === "2026-09-01T12:05:00.000Z"
              ? "new: something unplanned"
              : "new: first work of the window";
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "work",
              why: "ship",
              belongs: true,
              guess: null,
              quest: alias,
              stint,
              isSwitch: false,
              trigger: null,
              confidence: 0.9,
            },
          ],
          sessionNote: null,
        };
      }
    }

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new PlanGrainClassifier(),
      log: () => {},
      declareFile,
    });

    expect(metrics.stintsDismissed).toBe(1);
    expect(metrics.planStintsHit).toBe(1);
    expect(metrics.stintsNew).toBe(2);
  });
});
