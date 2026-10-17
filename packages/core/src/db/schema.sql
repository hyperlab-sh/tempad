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
  raw                  TEXT NOT NULL,     -- full column_values JSON
  org                  TEXT,              -- mapped org, from tempad.toml [[boards]] (or fallback)
  project              TEXT,              -- mapped project
  meta                 TEXT,              -- JSON of extra board-rule keys
  sync_host        TEXT,                   -- host tag of the last writer (0019)
  sync_updated_at  TEXT,                   -- last-write stamp, ms UTC ISO (0019)
  sync_dirty       INTEGER NOT NULL DEFAULT 1 -- 1 = not yet pushed (0019)
);
CREATE INDEX monday_items_updated ON monday_items(updated_at);

CREATE TABLE gh_repos (
  full_name      TEXT PRIMARY KEY,        -- org/repo
  org            TEXT NOT NULL,           -- mapped org, from tempad.toml [[repositories]] (or fallback lowercase owner)
  is_personal    INTEGER NOT NULL,
  default_branch TEXT,
  mirrored_at    TEXT,
  project        TEXT,                    -- mapped project
  meta           TEXT,                    -- JSON of extra repository-rule keys
  sync_host        TEXT,                   -- host tag of the last writer (0019)
  sync_updated_at  TEXT,                   -- last-write stamp, ms UTC ISO (0019)
  sync_dirty       INTEGER NOT NULL DEFAULT 1 -- 1 = not yet pushed (0019)
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
  deletions      INTEGER,
  sync_host        TEXT,                   -- host tag of the last writer (0019)
  sync_updated_at  TEXT,                   -- last-write stamp, ms UTC ISO (0019)
  sync_dirty       INTEGER NOT NULL DEFAULT 1 -- 1 = not yet pushed (0019)
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
  first_authored_at TEXT,                 -- earliest commit author date among the PR's commits
  updated_at  TEXT,                        -- GitHub's PR updated_at cursor, to detect changed PRs
  sync_host        TEXT,                   -- host tag of the last writer (0019)
  sync_updated_at  TEXT,                   -- last-write stamp, ms UTC ISO (0019)
  sync_dirty       INTEGER NOT NULL DEFAULT 1, -- 1 = not yet pushed (0019)
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
  project_name     TEXT,                  -- display name from a [[projects]] rule, if any
  title            TEXT,
  git_branch       TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT NOT NULL,
  message_count    INTEGER NOT NULL,
  tool_call_count  INTEGER NOT NULL,
  models           TEXT NOT NULL,         -- JSON array
  host_slug        TEXT NOT NULL,
  file_mtime       TEXT NOT NULL,
  title_source     TEXT,                  -- 'custom-title' | 'agent-name' | 'first-message' | 'none'
  entrypoint       TEXT,                  -- top-level `entrypoint` from the first user line
  user_type        TEXT,                  -- top-level `userType` from the first user line
  sync_host        TEXT,                   -- host tag of the last writer (0019)
  sync_updated_at  TEXT,                   -- last-write stamp, ms UTC ISO (0019)
  sync_dirty       INTEGER NOT NULL DEFAULT 1 -- 1 = not yet pushed (0019)
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
  tokens_out    INTEGER,
  sync_host        TEXT,                   -- host tag of the last writer (0019)
  sync_updated_at  TEXT,                   -- last-write stamp, ms UTC ISO (0019)
  sync_dirty       INTEGER NOT NULL DEFAULT 1 -- 1 = not yet pushed (0019)
);
CREATE INDEX claude_messages_ts ON claude_messages(ts);
CREATE INDEX claude_messages_session ON claude_messages(session_id);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor       TEXT NOT NULL,
  session_id  TEXT,
  kind        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  uid         TEXT,                      -- global ULID, replay order (0019)
  sync_host   TEXT,                      -- origin host (0019)
  sync_dirty  INTEGER NOT NULL DEFAULT 1 -- 1 = not yet pushed (0019)
);
CREATE INDEX events_subject ON events(subject, at);
CREATE INDEX events_kind ON events(kind, at);
CREATE INDEX events_quest_declared_session
  ON events(json_extract(payload, '$.session_id'))
  WHERE kind = 'quest.declared';
CREATE UNIQUE INDEX events_uid ON events(uid);
-- 0019 replaced the unconditional trigger: an update may only fill a NULL uid,
-- fill a NULL sync_host, and/or clear sync_dirty 1 -> 0 (see 0019_push_sync.sql).
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
WHEN NOT (
  NEW.id IS OLD.id AND NEW.at IS OLD.at AND NEW.recorded_at IS OLD.recorded_at AND
  NEW.actor IS OLD.actor AND NEW.session_id IS OLD.session_id AND NEW.kind IS OLD.kind AND
  NEW.subject IS OLD.subject AND NEW.payload IS OLD.payload AND
  (NEW.uid IS OLD.uid OR OLD.uid IS NULL) AND
  (NEW.sync_host IS OLD.sync_host OR OLD.sync_host IS NULL) AND
  (NEW.sync_dirty IS OLD.sync_dirty OR (OLD.sync_dirty = 1 AND NEW.sync_dirty = 0))
)
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE projection_state (
  name          TEXT PRIMARY KEY,
  last_event_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE w5_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'classify',
  forced       INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  claimed_at   TEXT,
  finished_at  TEXT,
  state        TEXT NOT NULL DEFAULT 'queued',
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE w5_runs (
  session_id      TEXT PRIMARY KEY,
  last_run_at     TEXT NOT NULL,
  last_message_ts TEXT,
  session_note    TEXT
);

CREATE TABLE w5_quiet (
  until TEXT NOT NULL
);

-- The `questions` table itself is owned by the `stints` projection
-- (src/intent/projections/stint.ts), not a migration, so it isn't
-- mirrored above like the tables from 0001-0004. Plan 2 added two columns
-- to that projection's CREATE TABLE: `turns_at_ask INTEGER` (turns_watched
-- value at the moment a question was asked, for expiry) and
-- `is_switch INTEGER NOT NULL DEFAULT 0` (carried on the question.asked
-- event payload, since traces have no isSwitch column of their own).
-- The declared-quests plan added `guess TEXT` (0010_verifier_questions.sql):
-- what the verifier thinks a doubted stretch of work looks like instead,
-- from which `w5 context` renders a `belongs` question's hand-back text.
--
-- Likewise `traces`, `stints` and `quests` (owned by the `stints`
-- and `quests` projections) each carry a `retracted_at TEXT` column, added
-- straight to their projection CREATE TABLE so a fresh database gets it for
-- free. Migration 0006_retractions.sql ALTERs the same column onto an
-- existing database's already-created projection tables (see
-- runMigration's tolerant-ALTER path in src/db/database.ts for why
-- that ALTER is safe to skip on a database where those tables don't exist
-- yet). A `retracted` event's `subject` is the id of the row it retracts;
-- projections apply it by UPDATEing whichever of traces/stints/quests
-- has a matching id.
--
-- Migration 0007_activity_lifecycle.sql added `close_reason TEXT` and
-- `continues TEXT` to what is now `stints` (mirrored above in the `stints`
-- projection's CREATE TABLE) and `session_note TEXT` to `w5_runs`.
--
-- Migration 0008_declared_quests.sql added origin_kind TEXT NOT NULL DEFAULT 'inferred' to quests.
--
-- Migration 0009_declared_quests_index.sql added events_quest_declared_session, a partial index
-- on json_extract(payload, '$.session_id') for kind = 'quest.declared' (mirrored above on the
-- events table), so declarations.ts's per-session lookups don't scan every quest.declared event.
--
-- Migration 0011_ubiquitous_language.sql renamed the domain vocabulary
-- (2026-09-07): `goals` -> `sagas`, `activities` -> `stints`, and the columns
-- `stints.objective` -> `outcome`, `traces.activity_id` /
-- `trace_links.activity_id` -> `stint_id`, `quests.goal_id` -> `serves`,
-- `quests.objective` -> `outcome`,
-- `quests.origin_activity_id` -> `deviates_from_stint_id`. It also dropped the
-- `stints.outcome` column that held a close-time judgment: nothing ever wrote
-- it, and `outcome` now names what the stint pursued. The `events` table
-- is append-only and was NOT rewritten: rows keep their original kinds and
-- payload field names, and src/intent/legacy.ts translates them at the single
-- read boundary in src/intent/store.ts. See
-- docs/specs/2026-09-07-ubiquitous-language.md.
--
-- Migration 0012_stint_minimum.sql added dismissed_at TEXT to stints.
--
-- Migration 0013_plan_stints.sql added plan_index TEXT and plan_item TEXT to
-- stints (mirrored in the `stints` projection's CREATE TABLE). A declaration's
-- --plan lists the stints a quest expects; the verifier names one as `P<n>.<m>`
-- and the stint opened for it records both the alias (plan_index) and the plan
-- line's text at that index (plan_item). Reuse is keyed on
-- (session, quest, plan_item) and never on the alias, which is stored for
-- display and audit only: plan numbering is assigned fresh per window, so
-- inserting a line ahead of an unfinished item moves it from `P1.1` to `P1.2`
-- while naming the same outcome, and keying on the alias would open a second
-- stint for work already in flight. See docs/specs/2026-09-07-stints-design.md.
--
-- Migration 0014_doubt_traces.sql added doubt TEXT to traces (mirrored in the
-- `stints` projection's CREATE TABLE): the verifier's `guess` for a
-- `belongs: false` segment, null when the segment belongs. `trace.recorded`
-- events carry `belongs`/`guess` in declared mode so this column -- and
-- `tempad review`/`w5 eval`'s `doubts_recorded` -- can audit every doubt
-- without a question ever having been asked about it.
--
-- Migration 0015_impacts.sql created the `impacts` table, mirrored below and
-- in the `impacts` projection's CREATE TABLE (src/intent/projections/impact.ts):
-- an `impact.stated` event's client-facing text and theme for one evidence ref
-- (`pr:<repo>#<number>`, `commit:<sha>`, `monday:<item id>`, `session:<claude
-- session id>`), keyed on that ref since a mirror row's own id is not stable
-- across sync sources. `retracted` clears a row the same way every other
-- retraction in this codebase does: `subject` is the id of the row it
-- retracts (here, the evidence ref itself), matched with `WHERE subject = ?`.
--
-- Migration 0016_impacts_session.sql widened `subject_kind`'s CHECK to add
-- `'session'`, for work with no commit/PR/Monday item (an ops session, an
-- unmirrored redesign) to still carry a client-facing impact line.

CREATE TABLE IF NOT EXISTS impacts (
  subject TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('pr', 'commit', 'monday', 'session')),
  text TEXT NOT NULL,
  theme TEXT,
  revision INTEGER NOT NULL,
  stated_at TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  retracted_at TEXT
);

-- Migration 0019_push_sync.sql (docs/specs/push-sync.md, "Schema changes")
-- added the sync columns mirrored above on `events` and the six collector
-- mirrors, the tables below, and per-mirror triggers `<table>_sync_insert`,
-- `<table>_sync_update` and `<table>_sync_delete` (defined only in the
-- migration): insert without a stamp -> stamp, tag with sync_local's host,
-- dirty; content update with the stamp untouched -> same; delete -> upsert a
-- `sync_tombstones` row keyed by the JSON array of the natural key. Each new
-- version of a key is stamped MAX(now, previous version's stamp + 1 ms), so
-- stamps strictly increase per key on one host. Host-local columns
-- (gh_repos.mirrored_at; `localColumns` in src/sync/tables.ts) are not
-- content and never restamp. The table
-- classification (synced-append / synced-upsert / local-only) lives in
-- src/sync/tables.ts.

CREATE TABLE sync_local (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  host_slug TEXT NOT NULL
);

CREATE TABLE sync_cursors (
  stream TEXT PRIMARY KEY,
  seq    INTEGER NOT NULL
);

CREATE TABLE sync_tombstones (
  tbl        TEXT NOT NULL,
  pk         TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  sync_host  TEXT,
  sync_dirty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tbl, pk)
);

-- Migration 0021_normalize_commit_dates.sql rewrote legacy offset-form
-- gh_commits.authored_at / committed_at to UTC ('...Z'). No schema change.
--
-- Migration 0024_side_quest_parent.sql added deviates_from_quest_id TEXT to
-- quests (mirrored in the `quests` projection's CREATE TABLE): the quest a
-- side quest deviates from when the branch names a quest instead of a stint.
