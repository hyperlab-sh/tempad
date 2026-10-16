-- Push sync, trigger gate (docs/specs/push-sync.md, "Trigger gate").
--
-- 0019 created the 18 mirror triggers unconditionally, so a host that never
-- configured [sync] paid for every stamp and kept a tombstone for every row
-- a collector deleted, forever. From here on the triggers exist only on a
-- database where sync has run: `sync_meta.mirror_sync_enabled` marks it, and
-- `reconcileMirrorTriggers` (src/sync/triggers.ts), which database.ts runs
-- inside this same transaction, installs src/sync/mirror-triggers.sql when
-- the marker is set. `enableMirrorSync` sets it on the first sync run.
--
-- A database that has already synced keeps its triggers and every pending
-- row, event and tombstone exactly as they were. The engine writes
-- `sync_meta` (`reseed_pending`, then `server_id`) on its first contact with
-- a server, before it pushes or pulls anything, so a non-empty `sync_meta` is
-- the evidence; cursors and anything already marked pushed are checked too.
INSERT INTO sync_meta (key, value)
SELECT 'mirror_sync_enabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE EXISTS (SELECT 1 FROM sync_meta)
    OR EXISTS (SELECT 1 FROM sync_cursors)
    OR EXISTS (SELECT 1 FROM events WHERE sync_dirty = 0)
    OR EXISTS (SELECT 1 FROM sync_tombstones WHERE sync_dirty = 0)
    OR EXISTS (SELECT 1 FROM gh_repos WHERE sync_dirty = 0)
    OR EXISTS (SELECT 1 FROM gh_commits WHERE sync_dirty = 0)
    OR EXISTS (SELECT 1 FROM gh_pull_requests WHERE sync_dirty = 0)
    OR EXISTS (SELECT 1 FROM monday_items WHERE sync_dirty = 0)
    OR EXISTS (SELECT 1 FROM claude_sessions WHERE sync_dirty = 0)
    OR EXISTS (SELECT 1 FROM claude_messages WHERE sync_dirty = 0);

-- Sync never ran: no remote will ever read these tombstones.
DELETE FROM sync_tombstones
 WHERE NOT EXISTS (SELECT 1 FROM sync_meta WHERE key = 'mirror_sync_enabled');

-- Reinstalled from mirror-triggers.sql (same text) when the marker is set.
DROP TRIGGER IF EXISTS gh_repos_sync_insert;
DROP TRIGGER IF EXISTS gh_repos_sync_update;
DROP TRIGGER IF EXISTS gh_repos_sync_delete;
DROP TRIGGER IF EXISTS gh_commits_sync_insert;
DROP TRIGGER IF EXISTS gh_commits_sync_update;
DROP TRIGGER IF EXISTS gh_commits_sync_delete;
DROP TRIGGER IF EXISTS gh_pull_requests_sync_insert;
DROP TRIGGER IF EXISTS gh_pull_requests_sync_update;
DROP TRIGGER IF EXISTS gh_pull_requests_sync_delete;
DROP TRIGGER IF EXISTS monday_items_sync_insert;
DROP TRIGGER IF EXISTS monday_items_sync_update;
DROP TRIGGER IF EXISTS monday_items_sync_delete;
DROP TRIGGER IF EXISTS claude_sessions_sync_insert;
DROP TRIGGER IF EXISTS claude_sessions_sync_update;
DROP TRIGGER IF EXISTS claude_sessions_sync_delete;
DROP TRIGGER IF EXISTS claude_messages_sync_insert;
DROP TRIGGER IF EXISTS claude_messages_sync_update;
DROP TRIGGER IF EXISTS claude_messages_sync_delete;
