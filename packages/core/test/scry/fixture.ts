import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { setSyncState } from "../../src/db/sync-state";
import type { W5Config } from "../../src/intent/config";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { backfill } from "../../src/w5/backfill";
import type { Classifier, ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";

registerAllProjections();

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** A fixed "now" so ages are exact; every seeded timestamp is built from it. */
export const NOW = new Date("2026-10-16T12:00:00.000Z");

export function ago(milliseconds: number, from: Date = NOW): string {
  return new Date(from.getTime() - milliseconds).toISOString();
}

export const w5Config: W5Config = {
  model: "m",
  throttleMinutes: 10,
  watchTurns: 3,
  askMinStintMinutes: 20,
  askBudgetMinutes: 30,
  askExpireTurns: 2,
  backfillDays: 15,
  backend: "claude-cli",
  claudeCommand: "claude",
  timeoutSeconds: 180,
  stintIdleMinutes: 45,
  memoryHours: 8,
  memoryStints: 10,
  memoryQuests: 20,
  overlapMessages: 3,
  mode: "declared",
  inferenceFallback: true,
  stintMinMinutes: 5,
};

const fullConfig: Config = {
  mondayApiToken: "t",
  mondayUser: "u",
  ghUser: "u",
  ghOrgs: [],
  ghIncludePersonal: false,
  ghToken: undefined,
  gitAuthorEmails: [],
  claudeDirs: [],
  hostSlug: "mac",
  tz: "UTC",
  since: "2020-01-01",
  syncToken: "unused",
  home: "/tmp",
};

class FakeClassifier implements Classifier {
  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    const first = window.messages[0]?.ts ?? NOW.toISOString();
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

export interface Home {
  directory: string;
  databasePath: string;
  /** A read-write handle, standing in for a hook or collector that writes while scry runs. */
  database: Database;
}

/**
 * A configured home: `.env` (HOST_SLUG only, which is all scry reads), an
 * optional `tempad.toml`, and a database at the head schema with every
 * collector synced one hour before NOW.
 */
export function makeHome(options: { toml?: string; hostSlug?: string | null } = {}): Home {
  const directory = mkdtempSync(join(tmpdir(), "tempad-scry-"));
  mkdirSync(directory, { recursive: true });
  const hostSlug = options.hostSlug === undefined ? "mac" : options.hostSlug;
  writeFileSync(
    join(directory, ".env"),
    hostSlug === null ? "TZ=UTC\n" : `HOST_SLUG=${hostSlug}\nTZ=UTC\n`,
  );
  if (options.toml !== undefined) writeFileSync(join(directory, "tempad.toml"), options.toml);
  const databasePath = join(directory, "tempad.db");
  const database = openDatabase(databasePath);
  for (const source of ["monday", "github", "claude"]) setSyncState(database, source, ago(HOUR));
  return { directory, databasePath, database };
}

export function seedHero(database: Database): void {
  ensureTables(database);
  applyIncremental(
    database,
    new EventStore(database).append({
      actor: "hero",
      kind: "hero.created",
      subject: "H1",
      payload: { name: "Saulo" },
    }),
  );
}

export function seedSession(
  database: Database,
  input: { id: string; endedAt: string; messageTimestamps?: string[]; hostSlug?: string },
): void {
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES (?, '/c', 'p', ?, '/w/p', 'personal', 'p', 't', 'main', ?, ?, 1, 0, '[]', ?, ?)`,
    )
    .run(
      input.id,
      `/c/p/${input.id}.jsonl`,
      input.endedAt,
      input.endedAt,
      input.hostSlug ?? "mac",
      input.endedAt,
    );
  for (const [index, ts] of (input.messageTimestamps ?? [input.endedAt]).entries()) {
    database
      .query(
        "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES (?, ?, ?, 'user', 0, 'work')",
      )
      .run(`${input.id}-m${index}`, input.id, ts);
  }
}

/** Runs the real backfill with a fake classifier, so the traces, stints and `window.classified` events are the real ones. */
export async function classifyAll(database: Database): Promise<void> {
  await backfill(database, fullConfig, w5Config, new FakeClassifier(), {
    days: 15,
    now: NOW.toISOString(),
    log: () => {},
  });
}

/**
 * A healthy home: a hero, six sessions that ended between 2 and 12 hours
 * before NOW, all classified (six sessions with traces, the eval baseline),
 * collectors synced an hour ago.
 */
export async function makeHealthyHome(
  options: { toml?: string; hostSlug?: string | null } = {},
): Promise<Home> {
  const home = makeHome(options);
  seedHero(home.database);
  for (let index = 0; index < 6; index += 1) {
    seedSession(home.database, { id: `healthy-${index}`, endedAt: ago((2 + index * 2) * HOUR) });
  }
  await classifyAll(home.database);
  return home;
}

export function insertFailedJob(
  database: Database,
  error: string,
  finishedAt: string,
  sessionId = "x",
): void {
  database
    .query(
      "INSERT INTO w5_jobs (session_id, requested_at, claimed_at, finished_at, state, error) VALUES (?, ?, ?, ?, 'failed', ?)",
    )
    .run(sessionId, finishedAt, finishedAt, finishedAt, error);
}
