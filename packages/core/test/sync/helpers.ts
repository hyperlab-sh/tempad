import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";
import { rebuildAll } from "../../src/intent/projections";
import { ALL_PROJECTIONS, registerAllProjections } from "../../src/intent/projections/register";
import type { RemoteStatement, SqlValue, SyncRemote } from "../../src/sync/engine";
import { SYNCED_UPSERT_TABLES } from "../../src/sync/tables";

/** In-process stand-in for sqld: the same SQL, run by bun:sqlite. */
export class FakeRemote implements SyncRemote {
  readonly database = new Database(":memory:");
  writes = 0;
  /** Throw on this (1-based) write call, before applying it. */
  failOnWrite: number | undefined;

  async query(sql: string, args: SqlValue[] = []): Promise<Record<string, SqlValue>[]> {
    return this.database.query(sql).all(...args) as Record<string, SqlValue>[];
  }

  async write(statements: RemoteStatement[]): Promise<void> {
    this.writes += 1;
    if (this.failOnWrite === this.writes) throw new Error("injected remote failure");
    this.database.transaction(() => {
      for (const statement of statements) this.database.query(statement.sql).run(...statement.args);
    })();
  }

  close(): void {}

  clock(): number {
    return (this.database.query("SELECT seq FROM sync_clock").get() as { seq: number }).seq;
  }
}

/** Wraps any remote so a chosen write call fails (partial-push tests). */
export function failingOnWrite(
  remote: SyncRemote,
  failOn: number,
): SyncRemote & { writes: number } {
  const wrapper = {
    writes: 0,
    query: remote.query.bind(remote),
    async write(statements: RemoteStatement[]) {
      wrapper.writes += 1;
      if (wrapper.writes === failOn) throw new Error("injected remote failure");
      await remote.write(statements);
    },
    close: () => remote.close(),
  };
  return wrapper;
}

export function temporaryDirectory(prefix = "tempad-sync-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function openHost(directory: string, hostSlug: string): Database {
  return openDatabase(join(directory, `${hostSlug}.db`), { hostSlug });
}

export function addRepository(
  database: Database,
  fullName: string,
  meta: string | null = null,
): void {
  database
    .query(
      `INSERT INTO gh_repos (full_name, org, is_personal, default_branch, mirrored_at, project, meta)
       VALUES (?, ?, 0, 'main', '2026-10-01T00:00:00.000Z', NULL, ?)
       ON CONFLICT (full_name) DO UPDATE SET meta = excluded.meta, mirrored_at = excluded.mirrored_at`,
    )
    .run(fullName, fullName.split("/")[0] ?? "acme", meta);
}

export function addCommit(
  database: Database,
  sha: string,
  repository: string,
  subject: string,
): void {
  database
    .query(
      `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject)
       VALUES (?, ?, '["main"]', 'Saulo', 'me@example.com', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', ?)
       ON CONFLICT (sha) DO UPDATE SET subject = excluded.subject`,
    )
    .run(sha, repository, subject);
}

export function addPullRequest(
  database: Database,
  repository: string,
  number: number,
  title: string,
): void {
  database
    .query(
      `INSERT INTO gh_pull_requests (repo, number, title, state, author, role, created_at)
       VALUES (?, ?, ?, 'open', 'octocat', 'author', '2026-10-01T10:00:00.000Z')
       ON CONFLICT (repo, number) DO UPDATE SET title = excluded.title`,
    )
    .run(repository, number, title);
}

export function addMondayItem(database: Database, id: number, name: string): void {
  database
    .query(
      `INSERT INTO monday_items (id, board_id, board_name, name, assignees, created_at, updated_at, raw)
       VALUES (?, 1, 'Board', ?, '[]', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', '{}')
       ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
    )
    .run(id, name);
}

export function addSession(
  database: Database,
  id: string,
  hostSlug: string,
  messages: string[] = [],
): void {
  database
    .query(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, org, project, started_at, ended_at,
         message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES (?, '/claude', 'p', '/claude/p/s.jsonl', 'acme', 'tempad', '2026-10-01T10:00:00.000Z',
         '2026-10-01T11:00:00.000Z', ?, 0, '[]', ?, '2026-10-01T11:00:00.000Z')`,
    )
    .run(id, messages.length, hostSlug);
  for (const [index, uuid] of messages.entries()) {
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain)
         VALUES (?, ?, ?, 'user', 0)`,
      )
      .run(uuid, id, `2026-10-01T10:${String(index).padStart(2, "0")}:00.000Z`);
  }
}

/** Runs a `tempad` intent subcommand (`hero init`, `party add`, ...) in-process. */
export async function intent(database: Database, args: string[]): Promise<void> {
  const code = await runIntentCommand(args, {
    database,
    config: { hostSlug: "test", home: "/nonexistent" } as Config,
    intentConfig: defaultIntentConfig(),
    stdout: () => {},
  });
  if (code !== 0) throw new Error(`tempad ${args.join(" ")} exited ${code}`);
}

/** Like `intent`, but returns what the command printed, one entry per line. */
export async function intentLines(database: Database, args: string[]): Promise<string[]> {
  const lines: string[] = [];
  const code = await runIntentCommand(args, {
    database,
    config: { hostSlug: "test", home: "/nonexistent" } as Config,
    intentConfig: defaultIntentConfig(),
    stdout: (line: string) => lines.push(line),
  });
  if (code !== 0) throw new Error(`tempad ${args.join(" ")} exited ${code}`);
  return lines;
}

/** Forces a row's stamp (and dirties it), to stage conflicts deterministically. */
export function restamp(
  database: Database,
  table: string,
  where: string,
  args: SqlValue[],
  stamp: string,
): void {
  database
    .query(`UPDATE ${table} SET sync_updated_at = ?, sync_dirty = 1 WHERE ${where}`)
    .run(stamp, ...args);
}

function rowsOf(database: Database, sql: string): unknown[] {
  return database.query(sql).all();
}

/**
 * Every synced table, as two hosts must agree on it: mirrors without their
 * host-local columns, events without the local integer id.
 */
export function sourceSnapshot(database: Database): Record<string, unknown[]> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of SYNCED_UPSERT_TABLES) {
    const columns = (
      database.query(`SELECT name FROM pragma_table_info('${table.name}')`).all() as {
        name: string;
      }[]
    )
      .map((row) => row.name)
      .filter((name) => !table.localColumns.includes(name));
    snapshot[table.name] = rowsOf(
      database,
      `SELECT ${columns.join(", ")} FROM ${table.name} ORDER BY ${table.keyColumns.join(", ")}`,
    );
  }
  snapshot.events = rowsOf(
    database,
    "SELECT uid, at, recorded_at, actor, session_id, kind, subject, payload, sync_host, sync_dirty FROM events ORDER BY uid",
  );
  return snapshot;
}

/** Every projection table, minus columns that hold a local event id. */
export function projectionSnapshot(database: Database): Record<string, unknown[]> {
  const snapshot: Record<string, unknown[]> = {};
  for (const projection of ALL_PROJECTIONS) {
    for (const table of projection.tables) {
      if (table === "projection_state") continue;
      const columns = (
        database.query(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => name !== "event_id" && name !== "last_event_id");
      if (columns.length === 0) continue;
      snapshot[table] = rowsOf(
        database,
        `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${columns.join(", ")}`,
      );
    }
  }
  return snapshot;
}

/**
 * A new in-memory database holding the same events as `source`, inserted in
 * random order (local ids then disagree with uid order) and rebuilt once:
 * the projections a host that had every event from the start would hold.
 */
export function rebuiltFromScratch(source: Database): Database {
  registerAllProjections();
  const target = openDatabase(":memory:");
  const rows = source
    .query(
      "SELECT at, recorded_at, actor, session_id, kind, subject, payload, uid, sync_host FROM events ORDER BY RANDOM()",
    )
    .all() as Record<string, string | null>[];
  const insert = target.query(
    `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload, uid, sync_host, sync_dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  for (const row of rows) {
    insert.run(
      row.at,
      row.recorded_at,
      row.actor,
      row.session_id,
      row.kind,
      row.subject,
      row.payload,
      row.uid,
      row.sync_host,
    );
  }
  rebuildAll(target);
  return target;
}
