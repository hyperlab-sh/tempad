-- Normalize legacy gh_commits timestamps to UTC.
--
-- Before b699db6 the GitHub collector stored git's %aI / %cI as written, in the
-- author's own offset ('2026-09-07T23:00:00-03:00'). Since then every write goes
-- through toUtcIso (new Date(s).toISOString(), e.g. '2026-09-08T02:00:00.000Z'),
-- but nothing rewrote the old rows, so one column held two forms that sort wrongly
-- against each other as text. This rewrites each offset-form value to exactly the
-- string a fresh collect writes: strftime's %f is SS.SSS, the same millisecond
-- precision toISOString gives.
--
-- A row is legacy when the value ends in a numeric offset (+HH:MM or -HH:MM). A
-- value ending in 'Z' (already UTC, with or without milliseconds) is left alone,
-- so a second run matches nothing. An unparseable value keeps its text (the
-- COALESCE) instead of becoming NULL in a NOT NULL column.
--
-- Sync: this is a pure function of the stored value, so every host reaches the
-- same result on its own, and nothing needs to be pushed for hosts to agree.
-- gh_commits_sync_update fires only when the row's stamp is unchanged, so the
-- first statement changes the stamp (appending a marker no real stamp contains)
-- to keep the trigger from restamping the row and marking it dirty. The second
-- statement puts the original stamp back; it changes the stamp too, so it does
-- not fire the trigger either. sync_host and sync_dirty are never written: a row
-- pushed before stays clean with its stamp, a row not yet pushed stays dirty and
-- goes out normalized. Both statements run inside the migration's transaction.
UPDATE gh_commits
   SET authored_at = CASE
         -- Only [-+]HH:MM is matched: git's %aI/%cI never emits +0300 (no colon).
         WHEN authored_at GLOB '*[-+][0-9][0-9]:[0-9][0-9]'
           THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', authored_at), authored_at)
         ELSE authored_at
       END,
       committed_at = CASE
         -- Only [-+]HH:MM is matched: git's %aI/%cI never emits +0300 (no colon).
         WHEN committed_at GLOB '*[-+][0-9][0-9]:[0-9][0-9]'
           THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', committed_at), committed_at)
         ELSE committed_at
       END,
       sync_updated_at = COALESCE(sync_updated_at, '') || '~'
 WHERE authored_at GLOB '*[-+][0-9][0-9]:[0-9][0-9]'
    OR committed_at GLOB '*[-+][0-9][0-9]:[0-9][0-9]';

UPDATE gh_commits
   SET sync_updated_at = NULLIF(substr(sync_updated_at, 1, length(sync_updated_at) - 1), '')
 WHERE sync_updated_at LIKE '%~';
