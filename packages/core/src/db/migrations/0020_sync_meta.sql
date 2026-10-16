-- Push sync, server identity (docs/specs/push-sync.md, "Cursors" > "Server
-- identity"). Holds `server_id`: the remote `sync_meta.server_id` this host
-- last pushed to. When the remote reports a different id (server rebuilt,
-- URL pointed elsewhere), sync re-seeds it from this host's own rows and
-- resets both pull cursors. Local-only; never shipped.
CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
