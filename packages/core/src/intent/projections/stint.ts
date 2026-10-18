import type { Projection } from "./index";

export const stintProjection: Projection = {
  name: "stints",
  tables: ["stints", "traces", "trace_links", "questions"],
  createSql: `
    CREATE TABLE IF NOT EXISTS stints (
      id TEXT PRIMARY KEY,
      quest_id TEXT,
      outcome TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      retracted_at TEXT,
      continues TEXT,
      close_reason TEXT,
      dismissed_at TEXT,
      plan_index TEXT,
      plan_item TEXT
    );
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      stint_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      place TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      who TEXT NOT NULL,
      what TEXT NOT NULL,
      why TEXT NOT NULL,
      where_text TEXT NOT NULL,
      how TEXT NOT NULL,
      confidence REAL NOT NULL,
      classified_by TEXT NOT NULL,
      session_id TEXT,
      recorded_at TEXT NOT NULL,
      retracted_at TEXT,
      doubt TEXT
    );
    CREATE TABLE IF NOT EXISTS trace_links (
      trace_id TEXT NOT NULL,
      stint_id TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      superseded_at TEXT,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      session_id TEXT,
      text TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'watching',
      asked_at TEXT,
      answered_at TEXT,
      answer TEXT,
      answered_by TEXT,
      turns_watched INTEGER NOT NULL DEFAULT 0,
      turns_at_ask INTEGER,
      is_switch INTEGER NOT NULL DEFAULT 0,
      guess TEXT
    );`,
  apply(database, event) {
    const payload = event.payload;
    switch (event.kind) {
      case "stint.opened":
        database
          .query(
            "INSERT OR REPLACE INTO stints (id, quest_id, outcome, opened_at, revision, continues, plan_index, plan_item) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
          )
          .run(
            event.subject,
            payload.quest ? String(payload.quest) : null,
            String(payload.outcome),
            event.at,
            // Nullish, not truthy: only an absent field means "no value". An
            // empty string is a value, and silently storing NULL for one would
            // lose it.
            payload.continues == null ? null : String(payload.continues),
            payload.plan_index == null ? null : String(payload.plan_index),
            payload.plan_item == null ? null : String(payload.plan_item),
          );
        return;
      case "stint.reworded":
        database
          .query("UPDATE stints SET outcome = ?, revision = revision + 1 WHERE id = ?")
          .run(String(payload.outcome), event.subject);
        return;
      case "stint.closed":
        database
          .query("UPDATE stints SET closed_at = ?, close_reason = ? WHERE id = ?")
          .run(event.at, payload.reason ? String(payload.reason) : null, event.subject);
        return;
      case "stint.dismissed":
        database
          .query("UPDATE stints SET dismissed_at = ? WHERE id = ?")
          .run(event.at, event.subject);
        return;
      case "stint.assigned":
        database
          .query("UPDATE stints SET quest_id = ? WHERE id = ?")
          .run(String(payload.quest), event.subject);
        return;
      case "trace.recorded":
        database
          .query(
            `INSERT OR REPLACE INTO traces
              (id, stint_id, tool, place, source, source_ref, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at, doubt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.subject,
            String(payload.stint),
            String(payload.tool),
            String(payload.place),
            String(payload.source),
            payload.source_ref ? String(payload.source_ref) : null,
            String(payload.started_at),
            String(payload.ended_at),
            String(payload.who),
            String(payload.what),
            String(payload.why),
            String(payload.where),
            String(payload.how),
            Number(payload.confidence),
            String(payload.classified_by),
            event.sessionId,
            event.recordedAt,
            // `belongs`/`guess` travel in the payload only when the verifier
            // recorded a doubt; a plain trace (inference mode, or a belonging
            // segment) carries neither and this stays null.
            payload.belongs === false && payload.guess ? String(payload.guess) : null,
          );
        database
          .query(
            "INSERT INTO trace_links (trace_id, stint_id, linked_at, superseded_at, reason) VALUES (?, ?, ?, NULL, NULL)",
          )
          .run(event.subject, String(payload.stint), event.at);
        return;
      case "trace.relinked":
        database
          .query(
            "UPDATE trace_links SET superseded_at = ? WHERE trace_id = ? AND superseded_at IS NULL",
          )
          .run(event.at, event.subject);
        database
          .query(
            "INSERT INTO trace_links (trace_id, stint_id, linked_at, superseded_at, reason) VALUES (?, ?, ?, NULL, ?)",
          )
          .run(
            event.subject,
            String(payload.stint),
            event.at,
            payload.reason ? String(payload.reason) : null,
          );
        database
          .query("UPDATE traces SET stint_id = ? WHERE id = ?")
          .run(String(payload.stint), event.subject);
        return;
      case "stint.continuation_cleared":
        // The stint it continued was retracted (a reset), so the link would
        // lead nowhere. The event keeps the old link in history.
        database.query("UPDATE stints SET continues = NULL WHERE id = ?").run(event.subject);
        return;
      case "question.asked":
        database
          .query(
            "INSERT OR REPLACE INTO questions (id, trace_id, session_id, text, kind, state, turns_watched, is_switch, guess) VALUES (?, ?, ?, ?, ?, 'watching', 0, ?, ?)",
          )
          .run(
            event.subject,
            String(payload.trace),
            event.sessionId,
            String(payload.text),
            String(payload.kind),
            payload.is_switch === true ? 1 : 0,
            payload.guess ? String(payload.guess) : null,
          );
        return;
      case "question.watched":
        database
          .query("UPDATE questions SET turns_watched = ? WHERE id = ?")
          .run(Number(payload.turns), event.subject);
        return;
      case "question.promoted":
        database
          .query(
            "UPDATE questions SET state = 'asked', asked_at = ?, turns_at_ask = ? WHERE id = ?",
          )
          .run(event.at, Number(payload.turnsAtAsk), event.subject);
        return;
      case "question.answered": {
        const why = payload.why ? String(payload.why) : undefined;
        const answer = why ?? (payload.quest ? String(payload.quest) : null);
        const answeredBy = payload.answeredBy ? String(payload.answeredBy) : String(event.actor);
        const state = answeredBy === "context" ? "resolved_by_context" : "answered";
        database
          .query(
            "UPDATE questions SET state = ?, answered_at = ?, answer = ?, answered_by = ? WHERE id = ?",
          )
          .run(state, event.at, answer, answeredBy, event.subject);
        // The hero settling a doubt (`--belongs` or `--quest`) clears the flag on
        // its trace. A context resolution does not: nobody judged the segment.
        // Expiry is a different event and never gets here, so an unanswered doubt
        // keeps its flag.
        if (state === "answered" && (payload.belongs === true || payload.quest)) {
          database
            .query(
              "UPDATE traces SET doubt = NULL WHERE id = (SELECT trace_id FROM questions WHERE id = ?)",
            )
            .run(event.subject);
        }
        return;
      }
      case "question.expired":
        database.query("UPDATE questions SET state = 'expired' WHERE id = ?").run(event.subject);
        return;
      case "retracted":
        // `event.subject` is the id of the retracted row. It names at most
        // one of a trace or a stint (ids are ULIDs from one global
        // sequence, so exactly one of these UPDATEs ever matches a row);
        // the quest case lives in quest.ts's own apply.
        database
          .query("UPDATE traces SET retracted_at = ? WHERE id = ? AND retracted_at IS NULL")
          .run(event.at, event.subject);
        database
          .query("UPDATE stints SET retracted_at = ? WHERE id = ? AND retracted_at IS NULL")
          .run(event.at, event.subject);
        return;
      default:
        return;
    }
  },
};
