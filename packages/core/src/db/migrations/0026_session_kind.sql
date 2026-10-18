-- What started each Claude session: human, lead, subagent or automated.
-- A cache of machine inference (rules first, then a small model call), so it
-- is a plain table, not an event: a pass of `tempad sync` overwrites a row
-- whenever the rules or the classifier version change, and losing the table
-- only costs a refill. A kind set by hand is a human decision and lives in
-- the event log instead (`session.kind_set`, projected into
-- session_kind_overrides), which wins over this table.
CREATE TABLE IF NOT EXISTS session_kind (
  session_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'lead', 'subagent', 'automated')),
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  classifier_version INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);
