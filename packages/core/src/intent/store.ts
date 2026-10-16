import type { Database } from "bun:sqlite";
import { EVENT_KINDS, type EventInput, type EventKind, type EventRecord } from "./events";
import { newUlid, ulidAfter } from "./ids";
import { rawKindsFor, translateLegacyKind, translateLegacyPayload } from "./legacy";

interface Row {
  id: number;
  at: string;
  recorded_at: string;
  actor: string;
  session_id: string | null;
  kind: string;
  subject: string;
  payload: string;
  uid: string | null;
  sync_host: string | null;
  sync_dirty: number;
}

function toRecord(row: Row): EventRecord {
  const kind = translateLegacyKind(row.kind);
  return {
    id: row.id,
    uid: row.uid,
    at: row.at,
    recordedAt: row.recorded_at,
    actor: row.actor as EventRecord["actor"],
    sessionId: row.session_id,
    kind: kind as EventKind,
    subject: row.subject,
    payload: translateLegacyPayload(kind, JSON.parse(row.payload) as Record<string, unknown>),
    syncHost: row.sync_host,
    syncDirty: row.sync_dirty === 1,
  };
}

export class EventStore {
  constructor(private readonly database: Database) {}

  append(input: EventInput): EventRecord {
    if (!EVENT_KINDS.includes(input.kind)) {
      throw new Error(`Unknown event kind: ${input.kind}`);
    }
    const now = new Date().toISOString();
    const at = input.at ?? now;
    // The uid must sort after every uid already stored, so that on one host
    // `ORDER BY uid` is exactly insertion order even across processes. The
    // max read and the insert share one IMMEDIATE transaction (a savepoint
    // when the caller already holds one), so no other writer slips between.
    const insert = this.database.transaction((): Row => {
      const maximum = (
        this.database.query("SELECT MAX(uid) AS uid FROM events").get() as {
          uid: string | null;
        }
      ).uid;
      return this.database
        .query(
          `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload, uid, sync_host)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT host_slug FROM sync_local WHERE id = 1))
           RETURNING *`,
        )
        .get(
          at,
          now,
          input.actor,
          input.sessionId ?? null,
          input.kind,
          input.subject,
          JSON.stringify(input.payload),
          ulidAfter(newUlid(), maximum),
        ) as Row;
    });
    return toRecord(insert.immediate());
  }

  read(
    options: { subject?: string; kind?: EventKind; until?: string; afterId?: number } = {},
  ): EventRecord[] {
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (options.subject) {
      clauses.push("subject = ?");
      parameters.push(options.subject);
    }
    if (options.kind) {
      // `options.kind` is a decoded name, but the column holds the kind as it
      // was written, so a plain `kind = ?` would miss every pre-rename row.
      // Match the whole set of raw kinds that decode to it instead -- without
      // this, `read({ kind })` silently bypasses the translation boundary.
      const rawKinds = rawKindsFor(options.kind);
      clauses.push(`kind IN (${rawKinds.map(() => "?").join(", ")})`);
      parameters.push(...rawKinds);
    }
    if (options.until) {
      clauses.push("at <= ?");
      parameters.push(options.until);
    }
    if (options.afterId !== undefined) {
      clauses.push("id > ?");
      parameters.push(options.afterId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    // Replay order is `uid`: identical on every host, and on one host exactly
    // insertion order (see `append` and openDatabase's legacy backfill). `id`
    // only breaks ties between rows inserted by hand, uid still NULL.
    const rows = this.database
      .query(`SELECT * FROM events ${where} ORDER BY uid, id`)
      .all(...parameters) as Row[];
    return rows.map(toRecord);
  }
}
