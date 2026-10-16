-- Adds the fourth evidence-ref shape, `session:<claude session id>`, to the
-- `impacts` CHECK constraint. SQLite cannot ALTER a CHECK constraint, so this
-- copies the table under a new name with the widened constraint, copies rows
-- across, drops the old table and renames the new one into place -- all
-- inside this migration's own transaction (see applyMigrations).
--
-- `impacts` is a projection table, created lazily by ensureTables rather than
-- by a migration, so a database where the intent layer was never used does
-- not have it yet. This migration is not a pure ALTER-TABLE file, so it does
-- not go through database.ts's per-statement tolerant path -- instead it
-- creates `impacts` with the *old* constraint first if missing, so the
-- rename-copy-drop below always has a real table to work from. On such a
-- database this is a no-op beyond that (zero rows to copy), and the
-- `impacts` projection's own createSql (src/intent/projections/impact.ts)
-- already matches the widened constraint for any table it creates from
-- scratch afterwards.

CREATE TABLE IF NOT EXISTS impacts (
  subject TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('pr', 'commit', 'monday')),
  text TEXT NOT NULL,
  theme TEXT,
  revision INTEGER NOT NULL,
  stated_at TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  retracted_at TEXT
);

CREATE TABLE impacts_new (
  subject TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('pr', 'commit', 'monday', 'session')),
  text TEXT NOT NULL,
  theme TEXT,
  revision INTEGER NOT NULL,
  stated_at TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  retracted_at TEXT
);

INSERT INTO impacts_new (subject, subject_kind, text, theme, revision, stated_at, event_id, retracted_at)
SELECT subject, subject_kind, text, theme, revision, stated_at, event_id, retracted_at FROM impacts;

DROP TABLE impacts;
ALTER TABLE impacts_new RENAME TO impacts;
