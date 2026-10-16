# TemPad core: collectors, schema, reports

> Vocabulary renamed on 2026-09-07, see docs/specs/2026-09-07-ubiquitous-language.md.

Status: draft for review. Date: 2026-09-04.

## Goal

Rebuild, from evidence, what a person and their agents worked on, per day and per hour, across three sources: Monday.com, GitHub, and Claude Code session transcripts. Store everything in SQLite so later runs only fetch what changed, and generate Markdown reports deterministically from the database.

Out of scope for this spec: the Go TUI, the `w5` hook and skill (separate spec), pushing hours into Deel.

## Non-goals

- No ORM. `bun:sqlite` with hand-written SQL.
- No attempt to reconstruct focused time. Elapsed spans are reported as upper bounds and labeled as such.
- No Monday.com writes.

## Repository placement

```
packages/core/
  package.json          name: @hyperlab.sh/tempad, bin: tempad
  moon.yml              tasks: lint, typecheck, test, sync, report
  tsconfig.json
  .env.example
  tempad.example.toml
  src/
    cli.ts              argument parsing, dispatch
    config/env.ts       load and validate .env from TEMPAD_HOME
    config/rules.ts     tempad.toml path rules (URLPattern)
    db/schema.sql
    db/database.ts      open, migrate, helpers
    collect/monday.ts
    collect/github.ts
    collect/claude.ts
    report/daily.ts
    report/project.ts
    report/hourly.ts
    report/markdown.ts  shared table rendering
  test/
    fixtures/           sample jsonl, recorded API JSON, git repo builder
    *.test.ts
```

## Configuration

### `TEMPAD_HOME/.env`

All variables below are required unless marked optional. A missing required variable throws at startup with the variable name.

| Variable              | Meaning                                                                                |
| --------------------- | -------------------------------------------------------------------------------------- |
| `MONDAY_API_TOKEN`    | Personal API token from monday.com profile settings                                    |
| `MONDAY_USER`         | Numeric user id. Name matching is a fallback when the id is absent from column JSON    |
| `GH_USER`             | GitHub login whose commits and PRs are collected                                       |
| `GH_ORGS`             | Comma-separated org logins, for example `mosaicstg`                                    |
| `GH_INCLUDE_PERSONAL` | `true` or `false`. Whether repos under `GH_USER` itself are also searched              |
| `GH_TOKEN`            | Optional. When absent, the `gh` CLI's stored auth is used via `gh api`                 |
| `GIT_AUTHOR_EMAILS`   | Comma-separated emails used to match commits in mirrors                                |
| `CLAUDE_DIRS`         | Comma-separated Claude Code home directories, for example `~/.claude,~/.claude-mosaic` |
| `HOST_SLUG`           | Short name for this machine, stored on every collected row                             |
| `TZ`                  | IANA zone used for day boundaries in reports, for example `America/Sao_Paulo`          |
| `SINCE`               | ISO date. Lower bound for the first sync of every source                               |

### `TEMPAD_HOME/tempad.toml`

Path rules map a working directory to `org` and `project`. Syntax is WHATWG `URLPattern` pathname syntax, evaluated by Bun's built-in `URLPattern`. Rules are tried in order; the first match wins. Named groups `org` and `project` are required, either from the pattern or from static fields on the rule. Every other named group is stored as metadata JSON on the row.

```toml
[[projects]]
pattern = "~/work/:org/:project/:rest*"

[[projects]]
pattern = "~/projects/:project/:rest*"
org = "personal"

[[projects]]
pattern = "/private/tmp/claude-501/-Users-svallory-work-:org-:project-:rest*"
```

`~` expands to the home directory before matching. Paths that match no rule get `org = "unassigned"`, `project = "unassigned"`.

## Schema

`schema.sql` is applied on open. `PRAGMA user_version` tracks migrations; migrations are numbered SQL files applied in order.

```sql
CREATE TABLE sync_state (
  source        TEXT PRIMARY KEY,        -- 'monday' | 'github' | 'claude'
  last_sync_at  TEXT NOT NULL,           -- ISO, UTC
  cursor        TEXT                     -- source-specific opaque string
);

CREATE TABLE monday_items (
  id                   INTEGER PRIMARY KEY,
  board_id             INTEGER NOT NULL,
  board_name           TEXT NOT NULL,
  group_name           TEXT,
  name                 TEXT NOT NULL,
  status               TEXT,
  assignees            TEXT NOT NULL,     -- JSON array of {id, name}
  timeline_start       TEXT,              -- ISO date
  timeline_end         TEXT,
  time_tracked_seconds INTEGER,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  raw                  TEXT NOT NULL      -- full column_values JSON
);
CREATE INDEX monday_items_updated ON monday_items(updated_at);

CREATE TABLE gh_repos (
  full_name      TEXT PRIMARY KEY,        -- org/repo
  org            TEXT NOT NULL,
  is_personal    INTEGER NOT NULL,
  default_branch TEXT,
  mirrored_at    TEXT
);

CREATE TABLE gh_commits (
  sha            TEXT PRIMARY KEY,
  repo           TEXT NOT NULL REFERENCES gh_repos(full_name),
  branches       TEXT NOT NULL,           -- JSON array of refs containing the sha
  author_name    TEXT NOT NULL,
  author_email   TEXT NOT NULL,
  authored_at    TEXT NOT NULL,
  committed_at   TEXT NOT NULL,
  subject        TEXT NOT NULL,
  body           TEXT,
  files_changed  INTEGER,
  insertions     INTEGER,
  deletions      INTEGER
);
CREATE INDEX gh_commits_authored ON gh_commits(authored_at);

CREATE TABLE gh_pull_requests (
  repo        TEXT NOT NULL REFERENCES gh_repos(full_name),
  number      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  state       TEXT NOT NULL,              -- open | closed | merged
  author      TEXT NOT NULL,
  role        TEXT NOT NULL,              -- author | reviewer
  created_at  TEXT NOT NULL,
  merged_at   TEXT,
  closed_at   TEXT,
  PRIMARY KEY (repo, number)
);

CREATE TABLE claude_sessions (
  id               TEXT PRIMARY KEY,      -- sessionId
  claude_dir       TEXT NOT NULL,
  project_dir      TEXT NOT NULL,         -- encoded folder under projects/
  file_path        TEXT NOT NULL,
  cwd              TEXT,
  org              TEXT NOT NULL,
  project          TEXT NOT NULL,
  path_meta        TEXT,                  -- JSON of extra named groups
  title            TEXT,
  git_branch       TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT NOT NULL,
  message_count    INTEGER NOT NULL,
  tool_call_count  INTEGER NOT NULL,
  models           TEXT NOT NULL,         -- JSON array
  host_slug        TEXT NOT NULL,
  file_mtime       TEXT NOT NULL
);
CREATE INDEX claude_sessions_started ON claude_sessions(started_at);

CREATE TABLE claude_messages (
  uuid          TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES claude_sessions(id),
  ts            TEXT NOT NULL,
  role          TEXT NOT NULL,            -- user | assistant | system
  is_sidechain  INTEGER NOT NULL,
  origin_kind   TEXT,                     -- human | agent | hook ...
  model         TEXT,
  text_preview  TEXT,                     -- first 500 chars of text content
  tool_name     TEXT,                     -- when the line is a tool_use
  tokens_in     INTEGER,
  tokens_out    INTEGER
);
CREATE INDEX claude_messages_ts ON claude_messages(ts);
CREATE INDEX claude_messages_session ON claude_messages(session_id);
```

Only `claude_sessions` carries `host_slug`: sessions are local to a machine, while commits and Monday items are global facts. The `w5` table from the later spec references `claude_sessions.id`.

## Collectors

Every collector exposes `sync(database, config, options): Promise<SyncSummary>` where the summary counts inserted, updated and deleted rows. The CLI prints one line per source.

### Monday

1. `GET boards` (all boards the token can see, paginated).
2. For each board, `items_page` with `limit: 500`, `query_params.rules = [{column_id: "__last_updated__", compare_value: [last_sync], operator: "greater_than"}]` when a cursor exists; no filter on first run. If the last-updated rule proves unreliable, fall back to full board pull and diff by `updated_at`.
3. Client-side filter: keep items whose people-type column JSON contains `MONDAY_USER` id, or whose text value contains the user's name. Do not use the API's people filter.
4. Extract `timeline` (start, end), `time_tracking` (duration seconds), `status` label. Column ids vary per board, so detection is by column `type`, not id.
5. Upsert by item id. Set `sync_state.monday.last_sync_at` to the sync start time.

### GitHub

1. Discover repos: for each org in `GH_ORGS`, `gh api search/commits -f q="author:GH_USER org:ORG author-date:>=SINCE"` and `search/issues` with `type:pr author:GH_USER org:ORG` and `type:pr reviewed-by:GH_USER org:ORG`. When `GH_INCLUDE_PERSONAL` is true, repeat with `user:GH_USER`. Union of repository names becomes rows in `gh_repos`. Search covers the default branch only, so this is a discovery step, not the source of truth.
2. Mirror: `git clone --mirror` into `TEMPAD_HOME/repos/<org>/<repo>.git` on first sight, `git remote update --prune` afterwards.
3. Log: `git log --all --no-merges --since=<lower> --format=<tab-separated fields> --shortstat` where `lower = max(SINCE, last_sync_at - 7 days)`. Rows matched by `GIT_AUTHOR_EMAILS`. Do not use `%`-based format strings through the RTK shell hook; the collector shells out with `Bun.spawn` and an argv array, bypassing the hook.
4. Reconcile: for every stored sha in the overlap window, verify `git cat-file -e <sha>` and `git branch -a --contains <sha>` in the mirror. Delete rows for shas no longer reachable. Update `branches`.
5. PRs: `gh api repos/<repo>/pulls?state=all&sort=updated&direction=desc`, stop at `updated_at < last_sync_at`. Store one row per (repo, number) with `role`.

### Claude

1. For each dir in `CLAUDE_DIRS`, glob `projects/*/*.jsonl`. Skip files whose mtime is before `last_sync_at` minus one hour.
2. Stream lines with `Bun.file(...).stream()` and a line splitter; never load a whole file. Parse each line as JSON; skip lines that fail.
3. Message lines (`type` in `user`, `assistant`, `system` with a `timestamp`) become `claude_messages`. `text_preview` is the first 500 chars of concatenated text blocks. `tool_name` is set when the assistant content includes a `tool_use` block. Tokens come from `message.usage`.
4. Session row: `id` from the first `sessionId` seen. `started_at`/`ended_at` are min/max timestamps. `cwd` and `gitBranch` from the first message line that carries them. `title` from a `custom-title` line, else `agent-name`, else the first `origin.kind == "human"` user message, truncated to 120 chars. `org`, `project`, `path_meta` come from applying path rules to `cwd`; if `cwd` is absent, decode `project_dir` (replace leading `-` with `/` and `-` with `/` where it forms an existing path) and apply rules to that.
5. Upsert sessions; insert messages with `INSERT OR IGNORE` by `uuid`.

Subagent transcripts appear as separate `.jsonl` files or as `isSidechain: true` lines within the parent. Both are stored; the hourly report groups sidechain lines under the parent session.

## Reports

`tempad report <daily|project|hourly> --from <date> --to <date> [--org X] [--project Y] [--out path]`. Output is Markdown written to `TEMPAD_HOME/reports/<kind>-<from>-<to>.md` and echoed to stdout. Day boundaries use `TZ`.

- **daily**: one heading per day; under it one block per project with commits (subject, sha7, repo), sessions (title, start to end, message count), Monday items whose timeline covers the day or whose `updated_at` falls on it, and PRs opened, merged or reviewed. Weekend days with nothing are omitted; weekdays with nothing print `no evidence`.
- **project**: one table per project. Rows are Monday items (or, for projects without Monday, git branches inferred from commit subjects). Columns: first evidence, last evidence, elapsed, commit count, session count. Elapsed is `last - first` and labeled as an upper bound.
- **hourly**: one table per day, 24 rows, columns per project. A cell lists what was active in that hour: session titles with message counts, commit sha7s. Sidechain messages roll up into their parent session.

Reports never invent rows. Day placement is by evidence timestamp only; redistributing batched commits to earlier days is a human editing step on the Markdown.

## Error handling

- Config errors throw before any network call, listing every missing variable at once.
- A collector failure aborts that source only; other sources still run. Exit code is non-zero if any source failed. `sync_state` is updated only on success.
- Rate limiting from GitHub search: honor `Retry-After`, retry up to three times, then fail the source.
- Malformed jsonl lines are counted and reported, not fatal.

## Testing

`bun test` with fixtures under `packages/core/test/fixtures`:

- `claude/`: three hand-made `.jsonl` files: a plain session, one with `custom-title` and sidechain lines, one with malformed lines and no `cwd`.
- `git/`: a helper that builds a temporary repository with commits at controlled dates and emails, then a mirror of it; a test rewrites history and asserts the orphaned sha is deleted.
- `monday/` and `github/`: recorded JSON responses; collectors take a `fetch`-compatible function so tests inject them.
- Rules: table-driven tests for `URLPattern` rules, including `~` expansion, metadata groups and the unassigned fallback.
- Idempotence: every collector runs twice against the same fixtures and the row counts are unchanged.
- Reports: golden Markdown files compared byte for byte.

## Open questions

None blocking. The Monday last-updated filter reliability is verified during implementation; the fallback is specified above.
