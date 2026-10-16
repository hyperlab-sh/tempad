# Push sync

Optional, eventually consistent exchange of source data between the operator's machines through one self-hosted sqld (libSQL server). Every machine keeps its own `bun:sqlite` database and reads only that in the hot path; `tempad sync` pushes local changes to sqld, pulls everyone else's, and rebuilds projections locally.

Status: design, 2026-10-16. Beads epic `tempad-25a`.

## Goals and non-goals

- Opt-in. No `[sync]` section in `tempad.toml` (or `enabled = false`) means zero network and `@libsql/client` is never loaded.
- Payload is every source table: the event log and every collector mirror. Projections are never shipped; each host rebuilds them from events.
- Idempotent: a second `tempad sync` with nothing new changes nothing locally or remotely. Two hosts that have both synced since the last change hold identical source tables (local integer `events.id` aside).
- Not in scope: real-time sync or daemons, Turso cloud, replacing `bun:sqlite`, remote reads from reports.

## Facts this design rests on

- `events.id` is `INTEGER PRIMARY KEY`, assigned by SQLite (`src/intent/store.ts:40`). It is **not** a ULID, so two hosts collide on it. Entity ids in subjects and payloads (`stint`, `quest`, `trace`, `retracts`, `continues`, ...) are ULIDs from `newUlid()` (`src/intent/ids.ts`) and are globally unique already.
- No payload field holds another event's integer id. `impacts.event_id` and `projection_state.last_event_id` store one but nothing reads them.
- The integer id is load-bearing in three places: replay order (`EventStore.read`, `ORDER BY id`), `w5 dedupe` "keep the lowest event id", and the "latest declaration" tiebreak `ORDER BY at DESC, id DESC` (`intent/declarations.ts`, `w5/apply.ts`, `w5/window.ts`). All three would diverge between hosts.
- Every collector upsert is `INSERT ... ON CONFLICT DO UPDATE ... WHERE <col> IS NOT excluded.<col> ...`, except `claude_messages` (`INSERT OR IGNORE`). The only collector delete is the GitHub reconcile (`DELETE FROM gh_commits WHERE sha = ?`).
- `claude_sessions.host_slug` already records the machine a session ran on. `HOST_SLUG` is required config.
- `w5 backfill` selects sessions with no host filter (`w5/backfill.ts:123`), so without a change every host would classify every other host's sessions and produce duplicate traces.

## Table classification

| Table                                                                                                                                     | Class                   | Natural key             | Notes                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------- | ---------------------------------------------------------------- |
| `events`                                                                                                                                  | synced-append           | `uid` (new ULID column) | `INSERT OR IGNORE` on `uid`; local `id` is reassigned on arrival |
| `gh_repos`                                                                                                                                | synced-upsert           | `full_name`             | parent of `gh_commits`, `gh_pull_requests`                       |
| `gh_commits`                                                                                                                              | synced-upsert           | `sha`                   | deletes propagate as tombstones                                  |
| `gh_pull_requests`                                                                                                                        | synced-upsert           | `(repo, number)`        |                                                                  |
| `monday_items`                                                                                                                            | synced-upsert           | `id`                    |                                                                  |
| `claude_sessions`                                                                                                                         | synced-upsert           | `id`                    | parent of `claude_messages`                                      |
| `claude_messages`                                                                                                                         | synced-upsert           | `uuid`                  | effectively insert-only, but uses the same path                  |
| `heroes`, `parties`, `memberships`, `clients`, `sagas`, `quests`, `stints`, `traces`, `trace_links`, `questions`, `impacts`, `w5_windows` | local-only (projection) |                         | rebuilt by `tempad rebuild`                                      |
| `projection_state`                                                                                                                        | local-only              |                         |                                                                  |
| `sync_state`                                                                                                                              | local-only              |                         | collector cursors are per host                                   |
| `w5_jobs`, `w5_runs`, `w5_quiet`                                                                                                          | local-only              |                         | job queue, per-session classifier memory, quiet window           |
| `sync_cursors`, `sync_tombstones`                                                                                                         | local-only              |                         | new, owned by sync                                               |
| `repos/` bare git mirrors                                                                                                                 | local-only              |                         | files, not tables                                                |

A new source table must be added to this list deliberately; the sync module keeps an explicit registry (table, key columns, parent order) and a unit test fails when a table exists in the schema that is in neither the synced nor the local-only list.

## Schema changes (migration `0019_push_sync.sql`)

Safe on existing databases: only `ADD COLUMN`, new tables, new triggers, and a trigger replacement.

**Events.**

- `ALTER TABLE events ADD COLUMN uid TEXT` and `ADD COLUMN sync_host TEXT`; `CREATE UNIQUE INDEX events_uid ON events(uid)` (SQLite allows many NULLs under a unique index).
- Replace `events_no_update` so the only permitted update fills a NULL `uid` and/or a NULL `sync_host` while every other column is unchanged. Content stays append-only; deletes stay forbidden.
- `EventStore.append` sets `uid = newUlid()`. Legacy rows get a uid once, right after migrations in `openDatabase`: in `id` order, a ULID seeded with the row's `recorded_at` from a monotonic factory, so legacy uids sort like their ids.
- `sync_host` NULL means "appended here, not yet pushed". Pulled events carry their origin host.

**Mirrors** (`gh_repos`, `gh_commits`, `gh_pull_requests`, `monday_items`, `claude_sessions`, `claude_messages`):

- `ADD COLUMN sync_host TEXT` and `ADD COLUMN sync_updated_at TEXT`. Existing rows get `sync_updated_at` = migration time and `sync_host` NULL, so the first push uploads them.
- `sync_host` is the host tag of the row's last writer; NULL means "changed here, not yet pushed" (a dirty flag). `claude_sessions.host_slug` keeps its meaning (where the session ran) and is untouched.
- Triggers per table, generated from its column list:
  - `AFTER INSERT ... WHEN NEW.sync_updated_at IS NULL`: stamp `sync_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')` (millisecond UTC).
  - `AFTER UPDATE ... WHEN NEW.sync_updated_at IS OLD.sync_updated_at AND (<any content column> IS NOT OLD.<col>)`: restamp and set `sync_host = NULL`. A pull writes an explicit `sync_updated_at`, so it never triggers a restamp; marking a row pushed changes only `sync_host`, which is not content, so it does not either. The collectors' `IS NOT` guards mean an unchanged re-collection never fires the trigger at all.
  - `AFTER DELETE`: insert `(table, key JSON, deleted_at = now)` into `sync_tombstones`, `sync_host` NULL.

**Sync bookkeeping:**

- `sync_cursors(stream TEXT PRIMARY KEY, seq INTEGER NOT NULL)`: last remote sequence pulled, streams `rows` and `events`.
- `sync_tombstones(tbl TEXT, pk TEXT, deleted_at TEXT, sync_host TEXT, PRIMARY KEY (tbl, pk))`.

## Remote schema

The remote database is a generic store, created with `IF NOT EXISTS` by the sync module on first contact. It deliberately does not mirror local DDL, so a local migration never needs a remote migration.

```sql
sync_meta(key TEXT PRIMARY KEY, value TEXT)          -- 'schema_version' = highest local user_version seen,
                                                     -- 'server_id' = random ULID written on first contact
sync_clock(id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)
sync_rows(tbl TEXT, pk TEXT, data TEXT,              -- data: JSON object of columns; NULL = tombstone
          sync_host TEXT NOT NULL, sync_updated_at TEXT NOT NULL, seq INTEGER NOT NULL,
          PRIMARY KEY (tbl, pk))
sync_events(uid TEXT PRIMARY KEY, data TEXT NOT NULL, sync_host TEXT NOT NULL, seq INTEGER NOT NULL)
-- indexes on sync_rows(seq) and sync_events(seq)
```

`pk` is the JSON array of the natural key values, e.g. `["hyperlab-sh/tempad",44]`.

## Conflict rule

Last writer wins on `(sync_updated_at, sync_host)`, compared as a row value: the newer stamp wins; on an identical stamp the lexically greater host slug wins. The rule is total and deterministic, so every host and the server pick the same winner regardless of arrival order. A tombstone competes under the same rule, so a delete beats an older write and loses to a newer one.

Applied in two places with the same comparison:

- Server, on push: `INSERT INTO sync_rows ... ON CONFLICT (tbl, pk) DO UPDATE SET ... WHERE (excluded.sync_updated_at, excluded.sync_host) > (sync_rows.sync_updated_at, sync_rows.sync_host)`. A losing or equal push changes nothing, including `seq`.
- Local, on pull: the same `ON CONFLICT ... WHERE`, with a local dirty row (`sync_host` NULL) compared as `(sync_updated_at, <own HOST_SLUG>)`.

Locally a tombstone competes too: a pulled row loses to a local tombstone with a newer `(deleted_at, host)`, and a pulled tombstone deletes the local row only when it wins. The delete trigger then writes a local tombstone; the pull rewrites it in the same transaction with the remote `deleted_at` and host, so it is not pushed back.

Events never conflict: they are immutable and keyed by `uid`.

Known trade-off: the stamp is the writer's wall clock. Machines are expected to run NTP; a host with a skewed clock wins or loses ties it should not. Acceptable for mirrors of upstream data that every host re-collects anyway.

## Cursors

- **Push needs no cursor.** The dirty flag is the cursor: push sends events and rows whose `sync_host IS NULL`, plus tombstones whose `sync_host IS NULL`. After a batch commits remotely, it is marked locally with `UPDATE ... SET sync_host = <own> WHERE <key> = ? AND sync_host IS NULL AND sync_updated_at = <pushed stamp>`, so a row a collector changed between read and mark stays dirty for the next run.
- **Pull uses a server sequence.** Every push batch runs in one remote write transaction that first does `UPDATE sync_clock SET seq = seq + 1 RETURNING seq` and writes that value into every row it changes. sqld serializes write transactions, so a committed `seq` is never overtaken by a lower one. Pull reads `WHERE seq > :cursor AND sync_host != :own ORDER BY seq` in pages and advances `sync_cursors` only after the page is applied locally.
- **Server identity.** The remote `sync_meta.server_id` is created once, on first contact with an empty server. The host stores the id it last synced with locally (`sync_cursors` gains no row for it; a local `sync_meta(key, value)` table holds `server_id`, added by the sync module's own migration). When the remote id differs from the stored one (server rebuilt from scratch, restored from an older backup, or URL pointed elsewhere), the run treats the server as unknown: it pushes every row, event and tombstone whose `sync_host` is NULL or its own slug, and resets both pull cursors to 0. That re-seeds a lost server from each host's copy without any manual step; pulling from 0 is safe because the local apply uses the same conflict rule.

## Event order across hosts

Replay order changes from `ORDER BY id` to `ORDER BY recorded_at, uid` in `EventStore.read`, `stateAsOf` (which also copies `uid`), `w5 dedupe` (keep the earliest by that order, not the lowest id), and the declaration tiebreaks (`at DESC, recorded_at DESC, uid DESC`). On a single host this is the same order as today except for same-millisecond ties across processes. Across hosts it is a total order that every host computes identically, which is what makes rebuilt projections converge. `projection_state.last_event_id` and `impacts.event_id` keep storing the local id; nothing reads them.

## Flow

`tempad sync [monday|github|claude] [--full] [--push] [--pull]`

- No direction flag: run the collectors exactly as today, then, if sync is enabled, push, pull and rebuild. Offline hosts see no change.
- `--push` and/or `--pull`: skip the collectors and run only those directions. Either flag with sync disabled exits 1 with `sync is not configured: add [sync] to tempad.toml`.
- Order within one run: schema check, push, pull, then `rebuildAll` when the pull inserted at least one event.
- Push order: `gh_repos`, `claude_sessions` before their children, then the rest, then events, then tombstones. Pull applies a page in one local transaction with `PRAGMA defer_foreign_keys = ON`, so parent/child order within a page does not matter.
- Pulled columns the local schema does not have are dropped; this is safe only because of the schema gate below.
- Output: one summary line, `sync: pushed events=<n> rows=<n> tombstones=<n> pulled events=<n> rows=<n> tombstones=<n> rebuilt=<yes|no>`.

**Schema gate.** Before pushing or pulling, compare the local `PRAGMA user_version` with remote `sync_meta.schema_version`. Local lower: refuse with `remote holds data from tempad schema <n>; upgrade tempad on this host (schema <m>)`, exit 1. Local higher: raise the remote value in the same transaction as the first push. Mixed versions would otherwise let an old host overwrite rows without the new columns.

**w5 stays host-local.** When sync is enabled, `w5 backfill` (and therefore `w5 eval`) only selects sessions with `claude_sessions.host_slug = HOST_SLUG`. A session is classified once, on the machine that has its transcript; its traces reach the others as events. Offline behaviour is unchanged. The live runner already works only from local hook jobs.

## Failure and partial push

- Each push batch (default 500 rows) is its own remote transaction plus its own local mark. A failure mid-run leaves earlier batches pushed and marked, later ones dirty; the next run resends only what is still dirty.
- A crash between remote commit and local mark resends that batch next run. Events hit `INSERT OR IGNORE`; rows tie on `(stamp, host)` and the `WHERE` rejects the update, so the resend changes nothing and does not bump `seq`.
- Pull pages are applied in one local transaction each, cursor included, so a failed page is retried whole.
- Any network or auth error ends the run with exit 1 and the error message; collectors that already ran keep their results. Nothing is retried in a loop.

## Configuration and token

```toml
[sync]
enabled = true # default true when the section exists
url = "libsql://tempad-sync.example.ts.net"
batch_size = 500 # optional
```

- `TEMPAD_SYNC_TOKEN` (process env, else `TEMPAD_HOME/.env`) is required only when sync is enabled. Missing, it throws `TEMPAD_SYNC_TOKEN is required when [sync] is enabled`. It has no default.
- `url` is required when enabled. Accepted schemes: `libsql:`, `https:`, `wss:`. Plain `http:`/`ws:` are accepted only for a loopback host (tests); any other plain-text URL is rejected so the token is never sent unencrypted.
- The token is a JWT signed with the Ed25519 key whose public half is `SQLD_AUTH_JWT_KEY` on the server (see `docs/deploy/sqld-coolify.md`). It is never printed, logged or written to `tempad.db`; error messages from the client are reported without the request headers.
- Config reading is a separate `loadSyncConfig(home, env)` called only by the sync path, so it slots into per-command config loading.
- `@libsql/client` is imported only by `src/sync/remote.ts`, which the sync path loads with a dynamic `import()` after `loadSyncConfig` returns an enabled config. A test runs an offline `tempad sync claude` with a resolver guard that fails if `@libsql/client` is ever resolved.

## Requirements on hosts

- `HOST_SLUG` must be unique per machine. Two machines with the same slug would each skip the other's rows on pull.
- Every host should run the same tempad version; the schema gate enforces the minimum.

## Tests

- Unit: classification registry covers every table; conflict comparison (newer stamp, tie on host, tombstone vs write); trigger behaviour (insert stamps, content update restamps and dirties, mark does not, unchanged re-collect does not, delete tombstones); event uid backfill and ordering; migration on a pre-0019 database.
- Integration against a real `ghcr.io/tursodatabase/libsql-server` container started in `beforeAll` with a generated Ed25519 key and torn down (`docker rm -f -v`) in `afterAll`: two hosts push and pull until both source tables are identical; a second sync is a no-op; partial push resumes; schema gate; rejected bad token. Skipped with a printed reason only when the `docker` CLI is absent.
