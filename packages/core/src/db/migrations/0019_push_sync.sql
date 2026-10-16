-- Push sync, local half (docs/specs/push-sync.md, "Schema changes").
--
-- Not a pure ALTER file, so database.ts runs it as one `exec` inside the
-- migration transaction: any failure rolls the whole file back. Every table
-- it touches (`events` and the six collector mirrors) is created by an
-- earlier migration, never lazily by a projection, so it applies the same
-- way to a fresh database and to an existing one.
--
-- `sync_local` holds this machine's host slug (openDatabase upserts it from
-- HOST_SLUG). Triggers and EventStore.append read it with a subquery; with no
-- row they write `sync_host` NULL, which push fills with its own slug.
CREATE TABLE sync_local (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  host_slug TEXT NOT NULL
);

CREATE TABLE sync_cursors (
  stream TEXT PRIMARY KEY,               -- 'rows' | 'events'
  seq    INTEGER NOT NULL                -- last remote sequence pulled
);

CREATE TABLE sync_tombstones (
  tbl        TEXT NOT NULL,              -- mirror table name
  pk         TEXT NOT NULL,              -- JSON array of the natural key values
  deleted_at TEXT NOT NULL,
  sync_host  TEXT,
  sync_dirty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tbl, pk)
);

-- Events: a global id (`uid`, a ULID; replay order is `ORDER BY uid`), the
-- origin host, and the push state. Legacy rows get their uid right after
-- migrations, in openDatabase (it needs a ULID factory SQL does not have).
ALTER TABLE events ADD COLUMN uid TEXT;
ALTER TABLE events ADD COLUMN sync_host TEXT;
ALTER TABLE events ADD COLUMN sync_dirty INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX events_uid ON events(uid);

-- The only permitted update fills a NULL uid, fills a NULL sync_host, and/or
-- clears sync_dirty from 1 to 0, with every other column unchanged. A column
-- added to `events` later must be added to this list too (a test checks).
DROP TRIGGER IF EXISTS events_no_update;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
WHEN NOT (
  NEW.id IS OLD.id AND
  NEW.at IS OLD.at AND
  NEW.recorded_at IS OLD.recorded_at AND
  NEW.actor IS OLD.actor AND
  NEW.session_id IS OLD.session_id AND
  NEW.kind IS OLD.kind AND
  NEW.subject IS OLD.subject AND
  NEW.payload IS OLD.payload AND
  (NEW.uid IS OLD.uid OR OLD.uid IS NULL) AND
  (NEW.sync_host IS OLD.sync_host OR OLD.sync_host IS NULL) AND
  (NEW.sync_dirty IS OLD.sync_dirty OR (OLD.sync_dirty = 1 AND NEW.sync_dirty = 0))
)
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

-- Mirrors: last writer's host, last-write stamp (millisecond UTC), push state.
-- Existing rows are stamped now and left dirty with no host, so the first
-- push uploads them (push fills the host).
ALTER TABLE gh_repos ADD COLUMN sync_host TEXT;
ALTER TABLE gh_repos ADD COLUMN sync_updated_at TEXT;
ALTER TABLE gh_repos ADD COLUMN sync_dirty INTEGER NOT NULL DEFAULT 1;
UPDATE gh_repos SET sync_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

ALTER TABLE gh_commits ADD COLUMN sync_host TEXT;
ALTER TABLE gh_commits ADD COLUMN sync_updated_at TEXT;
ALTER TABLE gh_commits ADD COLUMN sync_dirty INTEGER NOT NULL DEFAULT 1;
UPDATE gh_commits SET sync_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

ALTER TABLE gh_pull_requests ADD COLUMN sync_host TEXT;
ALTER TABLE gh_pull_requests ADD COLUMN sync_updated_at TEXT;
ALTER TABLE gh_pull_requests ADD COLUMN sync_dirty INTEGER NOT NULL DEFAULT 1;
UPDATE gh_pull_requests SET sync_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

ALTER TABLE monday_items ADD COLUMN sync_host TEXT;
ALTER TABLE monday_items ADD COLUMN sync_updated_at TEXT;
ALTER TABLE monday_items ADD COLUMN sync_dirty INTEGER NOT NULL DEFAULT 1;
UPDATE monday_items SET sync_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

ALTER TABLE claude_sessions ADD COLUMN sync_host TEXT;
ALTER TABLE claude_sessions ADD COLUMN sync_updated_at TEXT;
ALTER TABLE claude_sessions ADD COLUMN sync_dirty INTEGER NOT NULL DEFAULT 1;
UPDATE claude_sessions SET sync_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

ALTER TABLE claude_messages ADD COLUMN sync_host TEXT;
ALTER TABLE claude_messages ADD COLUMN sync_updated_at TEXT;
ALTER TABLE claude_messages ADD COLUMN sync_dirty INTEGER NOT NULL DEFAULT 1;
UPDATE claude_messages SET sync_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- Per-mirror triggers. Content columns are every column except sync_host,
-- sync_updated_at, sync_dirty and the table's host-local columns
-- (`localColumns` in src/sync/tables.ts, e.g. gh_repos.mirrored_at); a column
-- added to a mirror later must be added to its `_sync_update` trigger or to
-- `localColumns` (a test checks).
--
-- Stamps are strictly increasing per natural key on this host: each new
-- version gets MAX(now, previous version's stamp + 1 ms), so a burst of writes
-- in one millisecond never reuses a stamp. Push's "mark pushed WHERE
-- sync_updated_at = <pushed stamp>" then cannot clear a newer unpushed
-- version, and the server's last-writer-wins never ties two versions written
-- by one host. The previous version is OLD for an update or delete and the
-- key's tombstone (if any) for an insert. COALESCE guards a NULL or
-- unparseable previous stamp, which multi-argument MAX would turn into NULL.
--
-- _sync_insert: a row inserted without a stamp (every collector insert) is
-- stamped and tagged here. A pull inserts with an explicit stamp, so skips it.
-- An existing tombstone for the key is left alone: the re-insert's stamp is
-- above its deleted_at, so the row wins over it by stamp.
-- _sync_update: restamp and re-dirty only when the stamp is untouched and a
-- content column changed. A pull writes its own stamp; marking a row pushed
-- changes only sync_dirty/sync_host; an unchanged re-collection changes no
-- content column; a host-local column is not content. None of those fire it.
-- _sync_delete: upsert a tombstone keyed by the JSON natural key, so a
-- re-delete after a re-insert refreshes it.

-- gh_repos: natural key (full_name); local, not content: mirrored_at
CREATE TRIGGER gh_repos_sync_insert AFTER INSERT ON gh_repos
WHEN NEW.sync_updated_at IS NULL
BEGIN
  UPDATE gh_repos
     SET sync_updated_at = MAX(
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           COALESCE((SELECT strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at, '+0.001 seconds') FROM sync_tombstones
                      WHERE tbl = 'gh_repos' AND pk = json_array(NEW.full_name)), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER gh_repos_sync_update AFTER UPDATE ON gh_repos
WHEN NEW.sync_updated_at IS OLD.sync_updated_at AND (
  NEW.full_name IS NOT OLD.full_name OR
  NEW.org IS NOT OLD.org OR
  NEW.is_personal IS NOT OLD.is_personal OR
  NEW.default_branch IS NOT OLD.default_branch OR
  NEW.project IS NOT OLD.project OR
  NEW.meta IS NOT OLD.meta
)
BEGIN
  UPDATE gh_repos
     SET sync_updated_at = MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER gh_repos_sync_delete AFTER DELETE ON gh_repos
BEGIN
  INSERT INTO sync_tombstones (tbl, pk, deleted_at, sync_host, sync_dirty)
  VALUES ('gh_repos', json_array(OLD.full_name),
          MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
          (SELECT host_slug FROM sync_local WHERE id = 1), 1)
  ON CONFLICT (tbl, pk) DO UPDATE SET
    deleted_at = excluded.deleted_at, sync_host = excluded.sync_host, sync_dirty = 1;
END;

-- gh_commits: natural key (sha)
CREATE TRIGGER gh_commits_sync_insert AFTER INSERT ON gh_commits
WHEN NEW.sync_updated_at IS NULL
BEGIN
  UPDATE gh_commits
     SET sync_updated_at = MAX(
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           COALESCE((SELECT strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at, '+0.001 seconds') FROM sync_tombstones
                      WHERE tbl = 'gh_commits' AND pk = json_array(NEW.sha)), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER gh_commits_sync_update AFTER UPDATE ON gh_commits
WHEN NEW.sync_updated_at IS OLD.sync_updated_at AND (
  NEW.sha IS NOT OLD.sha OR
  NEW.repo IS NOT OLD.repo OR
  NEW.branches IS NOT OLD.branches OR
  NEW.author_name IS NOT OLD.author_name OR
  NEW.author_email IS NOT OLD.author_email OR
  NEW.authored_at IS NOT OLD.authored_at OR
  NEW.committed_at IS NOT OLD.committed_at OR
  NEW.subject IS NOT OLD.subject OR
  NEW.body IS NOT OLD.body OR
  NEW.files_changed IS NOT OLD.files_changed OR
  NEW.insertions IS NOT OLD.insertions OR
  NEW.deletions IS NOT OLD.deletions
)
BEGIN
  UPDATE gh_commits
     SET sync_updated_at = MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER gh_commits_sync_delete AFTER DELETE ON gh_commits
BEGIN
  INSERT INTO sync_tombstones (tbl, pk, deleted_at, sync_host, sync_dirty)
  VALUES ('gh_commits', json_array(OLD.sha),
          MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
          (SELECT host_slug FROM sync_local WHERE id = 1), 1)
  ON CONFLICT (tbl, pk) DO UPDATE SET
    deleted_at = excluded.deleted_at, sync_host = excluded.sync_host, sync_dirty = 1;
END;

-- gh_pull_requests: natural key (repo, number)
CREATE TRIGGER gh_pull_requests_sync_insert AFTER INSERT ON gh_pull_requests
WHEN NEW.sync_updated_at IS NULL
BEGIN
  UPDATE gh_pull_requests
     SET sync_updated_at = MAX(
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           COALESCE((SELECT strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at, '+0.001 seconds') FROM sync_tombstones
                      WHERE tbl = 'gh_pull_requests' AND pk = json_array(NEW.repo, NEW.number)), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER gh_pull_requests_sync_update AFTER UPDATE ON gh_pull_requests
WHEN NEW.sync_updated_at IS OLD.sync_updated_at AND (
  NEW.repo IS NOT OLD.repo OR
  NEW.number IS NOT OLD.number OR
  NEW.title IS NOT OLD.title OR
  NEW.state IS NOT OLD.state OR
  NEW.author IS NOT OLD.author OR
  NEW.role IS NOT OLD.role OR
  NEW.created_at IS NOT OLD.created_at OR
  NEW.merged_at IS NOT OLD.merged_at OR
  NEW.closed_at IS NOT OLD.closed_at OR
  NEW.first_authored_at IS NOT OLD.first_authored_at OR
  NEW.updated_at IS NOT OLD.updated_at
)
BEGIN
  UPDATE gh_pull_requests
     SET sync_updated_at = MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER gh_pull_requests_sync_delete AFTER DELETE ON gh_pull_requests
BEGIN
  INSERT INTO sync_tombstones (tbl, pk, deleted_at, sync_host, sync_dirty)
  VALUES ('gh_pull_requests', json_array(OLD.repo, OLD.number),
          MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
          (SELECT host_slug FROM sync_local WHERE id = 1), 1)
  ON CONFLICT (tbl, pk) DO UPDATE SET
    deleted_at = excluded.deleted_at, sync_host = excluded.sync_host, sync_dirty = 1;
END;

-- monday_items: natural key (id)
CREATE TRIGGER monday_items_sync_insert AFTER INSERT ON monday_items
WHEN NEW.sync_updated_at IS NULL
BEGIN
  UPDATE monday_items
     SET sync_updated_at = MAX(
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           COALESCE((SELECT strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at, '+0.001 seconds') FROM sync_tombstones
                      WHERE tbl = 'monday_items' AND pk = json_array(NEW.id)), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER monday_items_sync_update AFTER UPDATE ON monday_items
WHEN NEW.sync_updated_at IS OLD.sync_updated_at AND (
  NEW.id IS NOT OLD.id OR
  NEW.board_id IS NOT OLD.board_id OR
  NEW.board_name IS NOT OLD.board_name OR
  NEW.group_name IS NOT OLD.group_name OR
  NEW.name IS NOT OLD.name OR
  NEW.status IS NOT OLD.status OR
  NEW.assignees IS NOT OLD.assignees OR
  NEW.timeline_start IS NOT OLD.timeline_start OR
  NEW.timeline_end IS NOT OLD.timeline_end OR
  NEW.time_tracked_seconds IS NOT OLD.time_tracked_seconds OR
  NEW.created_at IS NOT OLD.created_at OR
  NEW.updated_at IS NOT OLD.updated_at OR
  NEW.raw IS NOT OLD.raw OR
  NEW.org IS NOT OLD.org OR
  NEW.project IS NOT OLD.project OR
  NEW.meta IS NOT OLD.meta
)
BEGIN
  UPDATE monday_items
     SET sync_updated_at = MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER monday_items_sync_delete AFTER DELETE ON monday_items
BEGIN
  INSERT INTO sync_tombstones (tbl, pk, deleted_at, sync_host, sync_dirty)
  VALUES ('monday_items', json_array(OLD.id),
          MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
          (SELECT host_slug FROM sync_local WHERE id = 1), 1)
  ON CONFLICT (tbl, pk) DO UPDATE SET
    deleted_at = excluded.deleted_at, sync_host = excluded.sync_host, sync_dirty = 1;
END;

-- claude_sessions: natural key (id)
CREATE TRIGGER claude_sessions_sync_insert AFTER INSERT ON claude_sessions
WHEN NEW.sync_updated_at IS NULL
BEGIN
  UPDATE claude_sessions
     SET sync_updated_at = MAX(
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           COALESCE((SELECT strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at, '+0.001 seconds') FROM sync_tombstones
                      WHERE tbl = 'claude_sessions' AND pk = json_array(NEW.id)), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER claude_sessions_sync_update AFTER UPDATE ON claude_sessions
WHEN NEW.sync_updated_at IS OLD.sync_updated_at AND (
  NEW.id IS NOT OLD.id OR
  NEW.claude_dir IS NOT OLD.claude_dir OR
  NEW.project_dir IS NOT OLD.project_dir OR
  NEW.file_path IS NOT OLD.file_path OR
  NEW.cwd IS NOT OLD.cwd OR
  NEW.org IS NOT OLD.org OR
  NEW.project IS NOT OLD.project OR
  NEW.path_meta IS NOT OLD.path_meta OR
  NEW.title IS NOT OLD.title OR
  NEW.git_branch IS NOT OLD.git_branch OR
  NEW.started_at IS NOT OLD.started_at OR
  NEW.ended_at IS NOT OLD.ended_at OR
  NEW.message_count IS NOT OLD.message_count OR
  NEW.tool_call_count IS NOT OLD.tool_call_count OR
  NEW.models IS NOT OLD.models OR
  NEW.host_slug IS NOT OLD.host_slug OR
  NEW.file_mtime IS NOT OLD.file_mtime OR
  NEW.title_source IS NOT OLD.title_source OR
  NEW.entrypoint IS NOT OLD.entrypoint OR
  NEW.user_type IS NOT OLD.user_type OR
  NEW.project_name IS NOT OLD.project_name
)
BEGIN
  UPDATE claude_sessions
     SET sync_updated_at = MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER claude_sessions_sync_delete AFTER DELETE ON claude_sessions
BEGIN
  INSERT INTO sync_tombstones (tbl, pk, deleted_at, sync_host, sync_dirty)
  VALUES ('claude_sessions', json_array(OLD.id),
          MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
          (SELECT host_slug FROM sync_local WHERE id = 1), 1)
  ON CONFLICT (tbl, pk) DO UPDATE SET
    deleted_at = excluded.deleted_at, sync_host = excluded.sync_host, sync_dirty = 1;
END;

-- claude_messages: natural key (uuid)
CREATE TRIGGER claude_messages_sync_insert AFTER INSERT ON claude_messages
WHEN NEW.sync_updated_at IS NULL
BEGIN
  UPDATE claude_messages
     SET sync_updated_at = MAX(
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           COALESCE((SELECT strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at, '+0.001 seconds') FROM sync_tombstones
                      WHERE tbl = 'claude_messages' AND pk = json_array(NEW.uuid)), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER claude_messages_sync_update AFTER UPDATE ON claude_messages
WHEN NEW.sync_updated_at IS OLD.sync_updated_at AND (
  NEW.uuid IS NOT OLD.uuid OR
  NEW.session_id IS NOT OLD.session_id OR
  NEW.ts IS NOT OLD.ts OR
  NEW.role IS NOT OLD.role OR
  NEW.is_sidechain IS NOT OLD.is_sidechain OR
  NEW.origin_kind IS NOT OLD.origin_kind OR
  NEW.model IS NOT OLD.model OR
  NEW.text_preview IS NOT OLD.text_preview OR
  NEW.tool_name IS NOT OLD.tool_name OR
  NEW.tokens_in IS NOT OLD.tokens_in OR
  NEW.tokens_out IS NOT OLD.tokens_out
)
BEGIN
  UPDATE claude_messages
     SET sync_updated_at = MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
         sync_host = (SELECT host_slug FROM sync_local WHERE id = 1),
         sync_dirty = 1
   WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER claude_messages_sync_delete AFTER DELETE ON claude_messages
BEGIN
  INSERT INTO sync_tombstones (tbl, pk, deleted_at, sync_host, sync_dirty)
  VALUES ('claude_messages', json_array(OLD.uuid),
          MAX(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', OLD.sync_updated_at, '+0.001 seconds'), '')),
          (SELECT host_slug FROM sync_local WHERE id = 1), 1)
  ON CONFLICT (tbl, pk) DO UPDATE SET
    deleted_at = excluded.deleted_at, sync_host = excluded.sync_host, sync_dirty = 1;
END;
