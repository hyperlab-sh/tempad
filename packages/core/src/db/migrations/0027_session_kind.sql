-- The kind of every Claude session: human, lead, subagent or automated.
-- One projection of the event log and the collected facts, one row per
-- session and origin: a kind set by hand (`session.kind_set`, always winning),
-- a model decision (`session.kind_inferred`, replayed by a rebuild instead of
-- calling the model again) and the rule a pass over claude_sessions /
-- claude_messages recomputes. tempad rebuild restores all three.
CREATE TABLE IF NOT EXISTS session_kind (
  session_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'model', 'rule')),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'lead', 'subagent', 'automated')),
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  classifier_version INTEGER NOT NULL,
  set_at TEXT NOT NULL,
  event_uid TEXT,
  PRIMARY KEY (session_id, origin)
);
