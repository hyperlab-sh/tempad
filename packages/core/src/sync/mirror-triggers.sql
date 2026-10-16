-- The 18 push-sync triggers on the six collector mirrors, as installed on a
-- database where sync is enabled (docs/specs/push-sync.md, "Schema changes" >
-- "Trigger gate"). Migration 0019 created them unconditionally; migration
-- 0022 drops them, and `reconcileMirrorTriggers` (src/sync/triggers.ts)
-- installs this file when the database carries the `mirror_sync_enabled`
-- marker in `sync_meta`, which `enableMirrorSync` sets the first time a sync
-- runs. A host without `[sync]` therefore pays no per-row trigger cost and
-- writes no tombstones.
--
-- This file is the single definition of the triggers. Each statement must
-- start with `CREATE TRIGGER <name>` and end with a line holding only `END;`:
-- `src/sync/triggers.ts` splits it there and compares each statement with the
-- text SQLite stored in `sqlite_master`, reinstalling a trigger whose text
-- differs. Editing a trigger here is enough; every enabled database picks it
-- up the next time it is opened.
--
-- Content columns are every column except sync_host, sync_updated_at,
-- sync_dirty and the table's host-local columns (`localColumns` in
-- src/sync/tables.ts, e.g. gh_repos.mirrored_at); a column added to a mirror
-- later must be added to its `_sync_update` trigger here or to `localColumns`
-- (test/migration-0019.test.ts checks).
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
