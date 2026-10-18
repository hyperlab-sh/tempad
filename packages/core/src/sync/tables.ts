/**
 * The push-sync table registry (docs/specs/push-sync.md, "Table
 * classification"). Every table in the schema is in exactly one of the three
 * lists below; `test/sync/tables.test.ts` fails when a table exists that is
 * not classified, so a new table has to be placed deliberately.
 *
 * No network code lives here: the sync path and the tests both import it.
 */

/** Append-only, keyed by a global id; pushed with `INSERT OR IGNORE`. */
export interface SyncedAppendTable {
  name: string;
  keyColumns: readonly string[];
}

/** Collector mirror; last writer wins on `(sync_updated_at, sync_host)`. */
export interface SyncedUpsertTable {
  name: string;
  /** Natural key, in the order the tombstone `pk` JSON array lists it. */
  keyColumns: readonly string[];
  /**
   * Columns that describe this machine rather than the shared fact. They are
   * not content: changing one does not restamp or re-dirty the row (the
   * `_sync_update` trigger leaves them out). Push leaves them out of the
   * payload and pull never overwrites them, so a row first seen through a
   * pull has them NULL until this host's own collector writes them.
   */
  localColumns: readonly string[];
}

export const SYNCED_APPEND_TABLES: readonly SyncedAppendTable[] = [
  { name: "events", keyColumns: ["uid"] },
];

/**
 * In push order: a parent precedes its children (`gh_repos` before
 * `gh_commits`/`gh_pull_requests`, `claude_sessions` before
 * `claude_messages`), so the remote never holds a child without its parent.
 */
export const SYNCED_UPSERT_TABLES: readonly SyncedUpsertTable[] = [
  // mirrored_at is when *this* host last fetched its own bare mirror.
  { name: "gh_repos", keyColumns: ["full_name"], localColumns: ["mirrored_at"] },
  // claude_dir, file_path and file_mtime name a file on the owning host, but
  // only that host's collector ever writes them (other hosts never see the
  // file), they are NOT NULL, and they record where the session came from:
  // they sync as content.
  { name: "claude_sessions", keyColumns: ["id"], localColumns: [] },
  { name: "gh_commits", keyColumns: ["sha"], localColumns: [] },
  { name: "gh_pull_requests", keyColumns: ["repo", "number"], localColumns: [] },
  { name: "monday_items", keyColumns: ["id"], localColumns: [] },
  { name: "claude_messages", keyColumns: ["uuid"], localColumns: [] },
];

/** Never shipped: projections (rebuilt from events) and per-host state. */
export const LOCAL_ONLY_TABLES: readonly string[] = [
  // Projections, rebuilt by `tempad rebuild`.
  "heroes",
  "parties",
  "memberships",
  "membership_leaves",
  "clients",
  "sagas",
  "quests",
  "stints",
  "traces",
  "trace_links",
  "questions",
  "impacts",
  "w5_windows",
  "w5_stale_windows",
  "projection_state",
  // Cross-host identity aliases (src/intent/identity.ts), rebuilt with the rest.
  "identity_aliases",
  // Collector cursors are per host.
  "sync_state",
  // w5 job queue, per-session classifier memory, quiet window.
  "w5_jobs",
  "w5_runs",
  "w5_quiet",
  // Owned by sync itself.
  "sync_local",
  "sync_cursors",
  "sync_tombstones",
  "sync_meta",
];

/** Columns sync owns on every synced-upsert table; never content. */
export const MIRROR_SYNC_COLUMNS: readonly string[] = [
  "sync_host",
  "sync_updated_at",
  "sync_dirty",
];
