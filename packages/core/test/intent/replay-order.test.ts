import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTime, encodeTime } from "ulid";
import { openDatabase } from "../../src/db/database";
import { declareQuest } from "../../src/intent/declarations";
import type { EventInput, EventKind, EventRecord } from "../../src/intent/events";
import { translateLegacyKind, translateLegacyPayload } from "../../src/intent/legacy";
import {
  applyIncremental,
  ensureTables,
  listProjections,
  rebuildAll,
} from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { stateAsOf } from "../../src/intent/time-travel";
import { OLD_EVENTS } from "../fixtures/legacy/old-schema";

registerAllProjections();

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "tempad-replay-order-"));
}

function projectionTables(): string[] {
  return [...listProjections().flatMap((projection) => projection.tables), "projection_state"];
}

/** Every projection row, rowid included, so insertion order differences show too. */
function snapshot(database: Database): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const table of projectionTables()) {
    result[table] = database.query(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`).all();
  }
  return result;
}

interface RawEventRow {
  id: number;
  at: string;
  recorded_at: string;
  actor: string;
  session_id: string | null;
  kind: string;
  subject: string;
  payload: string;
}

/**
 * The pre-0019 rebuild: `rebuildAll` exactly as it ran before push sync, with
 * `EventStore.read`'s old `ORDER BY id` and its translation of legacy kinds.
 */
function rebuildInIdOrder(database: Database): void {
  ensureTables(database);
  const rows = database.query("SELECT * FROM events ORDER BY id").all() as RawEventRow[];
  const events: EventRecord[] = rows.map((row) => {
    const kind = translateLegacyKind(row.kind);
    return {
      id: row.id,
      uid: null,
      at: row.at,
      recordedAt: row.recorded_at,
      actor: row.actor as EventRecord["actor"],
      sessionId: row.session_id,
      kind: kind as EventKind,
      subject: row.subject,
      payload: translateLegacyPayload(kind, JSON.parse(row.payload) as Record<string, unknown>),
      syncHost: null,
      syncDirty: true,
    };
  });
  const run = database.transaction(() => {
    for (const projection of listProjections()) {
      for (const table of projection.tables) database.exec(`DELETE FROM ${table}`);
      for (const event of events) projection.apply(database, event);
      database
        .query(
          "INSERT INTO projection_state (name, last_event_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_event_id = excluded.last_event_id",
        )
        .run(projection.name, events.at(-1)?.id ?? 0);
    }
  });
  run();
}

function insertRaw(
  database: Database,
  event: {
    at: string;
    recordedAt: string;
    kind: string;
    subject: string;
    payload: Record<string, unknown>;
    actor?: string;
    sessionId?: string | null;
    uid?: string;
    syncHost?: string;
  },
): void {
  database
    .query(
      `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload${event.uid ? ", uid, sync_host, sync_dirty" : ""})
       VALUES (?, ?, ?, ?, ?, ?, ?${event.uid ? ", ?, ?, 0" : ""})`,
    )
    .run(
      event.at,
      event.recordedAt,
      event.actor ?? "hero",
      event.sessionId ?? null,
      event.kind,
      event.subject,
      JSON.stringify(event.payload),
      ...(event.uid ? [event.uid, event.syncHost ?? "host-b"] : []),
    );
}

/** A ULID at a given time with a fixed random half, for hand-built "pulled" events. */
function ulidAt(time: string, random: string): string {
  return `${encodeTime(Date.parse(time), 10)}${random.padStart(16, "0")}`;
}

describe("replay order before and after migration 0019", () => {
  test("a pre-0019 history with same-millisecond and backwards recorded_at rebuilds identically", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    try {
      const old = openDatabase(path, { upToVersion: 18 });

      // The legacy fixture, its recorded_at bent out of shape: runs of rows
      // sharing one millisecond, and rows recorded "before" the row ahead of
      // them in id order (a clock step, two processes).
      const bent = [
        "2026-09-01T09:00:00.000Z",
        "2026-09-01T09:00:00.000Z",
        "2026-09-01T09:00:00.000Z",
        "2026-09-01T08:00:00.000Z",
        "2026-09-01T10:30:00.000Z",
        "2026-09-01T10:30:00.000Z",
        "2026-09-01T10:00:00.000Z",
        "2026-09-01T10:40:00.000Z",
        "2026-09-01T07:00:00.000Z",
        "2026-09-01T11:05:00.000Z",
        "2026-09-01T11:05:00.000Z",
      ];
      expect(bent).toHaveLength(OLD_EVENTS.length);
      OLD_EVENTS.forEach((event, index) => {
        insertRaw(old, {
          at: event.at,
          recordedAt: bent[index] as string,
          actor: event.actor,
          sessionId: event.sessionId,
          kind: event.kind,
          subject: event.subject,
          payload: event.payload,
        });
      });
      // Order-sensitive rewrites of one subject, where only id order picks the
      // winner: three rewords in one millisecond, then one recorded earlier.
      const rewords: [string, string, string, string][] = [
        ["G1", "goal.reworded", "2026-09-01T12:00:00.000Z", "first"],
        ["G1", "goal.reworded", "2026-09-01T12:00:00.000Z", "second"],
        ["G1", "goal.reworded", "2026-09-01T12:00:00.000Z", "third"],
        ["Q1", "quest.reworded", "2026-09-01T12:00:00.000Z", "quest first"],
        ["G1", "goal.reworded", "2026-09-01T06:00:00.000Z", "last by id"],
        ["Q1", "quest.reworded", "2026-08-31T00:00:00.000Z", "quest last by id"],
      ];
      for (const [subject, kind, recordedAt, title] of rewords) {
        insertRaw(old, {
          at: "2026-09-01T12:00:00.000Z",
          recordedAt,
          kind,
          subject,
          payload: { title },
        });
      }

      rebuildInIdOrder(old);
      const before = snapshot(old);
      old.close();

      const database = openDatabase(path);
      expect(
        (database.query("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(21);
      rebuildAll(database);
      const after = snapshot(database);

      expect(after).toEqual(before);
      // And the winners are the id-order ones, not the recorded_at-order ones.
      expect(database.query("SELECT title FROM sagas WHERE id = 'G1'").get()).toEqual({
        title: "last by id",
      });
      expect(database.query("SELECT title FROM quests WHERE id = 'Q1'").get()).toEqual({
        title: "quest last by id",
      });
      expect((after.stints as unknown[]).length).toBeGreaterThan(0);
      expect((after.traces as unknown[]).length).toBeGreaterThan(0);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("single host with sync off", () => {
  function runFlow(database: Database): void {
    const store = new EventStore(database);
    const append = (input: EventInput) => applyIncremental(database, store.append(input));
    append({ actor: "hero", kind: "hero.created", subject: "H1", payload: { name: "S" } });
    append({
      actor: "hero",
      kind: "saga.created",
      subject: "G1",
      payload: { owner: { kind: "hero", id: "H1" }, title: "saga" },
    });
    for (const title of ["one", "two", "three", "four"]) {
      append({ actor: "hero", kind: "saga.reworded", subject: "G1", payload: { title } });
    }
    append({
      actor: "hero",
      kind: "quest.created",
      subject: "Q1",
      payload: { owner: { kind: "hero", id: "H1" }, serves: "G1", title: "quest", confirmed: true },
    });
    declareQuest(store, database, {
      sessionId: "s1",
      at: "2026-09-01T10:00:00.000Z",
      questId: "Q1",
      plan: ["write it"],
      scope: "session",
      declaredBy: "hero",
      heroId: "H1",
    });
    append({
      actor: "hook",
      kind: "stint.opened",
      subject: "S1",
      at: "2026-09-01T10:00:00.000Z",
      payload: { outcome: "write it", quest: "Q1" },
    });
    for (const [trace, start, end] of [
      ["T1", "2026-09-01T10:00:00.000Z", "2026-09-01T10:30:00.000Z"],
      ["T2", "2026-09-01T10:00:00.000Z", "2026-09-01T10:30:00.000Z"],
      ["T3", "2026-09-01T10:30:00.000Z", "2026-09-01T11:00:00.000Z"],
    ] as const) {
      append({
        actor: "backfill",
        kind: "trace.recorded",
        subject: trace,
        sessionId: "s1",
        payload: {
          stint: "S1",
          tool: "claude-code",
          place: "p",
          source: "session",
          started_at: start,
          ended_at: end,
          who: "hero",
          what: "work",
          why: "ship",
          where: "personal/p",
          how: "claude-code",
          confidence: 0.9,
          classified_by: "assistant",
        },
      });
    }
    append({
      actor: "backfill",
      kind: "retracted",
      subject: "T2",
      payload: { retracts: "T2", reason: "duplicate backfill window" },
    });
    append({ actor: "hook", kind: "stint.closed", subject: "S1", payload: { reason: "idle" } });
  }

  test("uid order is id order, and rebuilding gives the id-order projections", () => {
    const directory = temporaryDirectory();
    try {
      const database = openDatabase(join(directory, "tempad.db"));
      runFlow(database);

      const rows = database
        .query("SELECT id, uid, sync_host, sync_dirty FROM events ORDER BY id")
        .all() as {
        id: number;
        uid: string;
        sync_host: string | null;
        sync_dirty: number;
      }[];
      expect(rows.length).toBeGreaterThan(10);
      expect([...rows].sort((a, b) => (a.uid < b.uid ? -1 : 1)).map((row) => row.id)).toEqual(
        rows.map((row) => row.id),
      );
      for (const row of rows) {
        expect(row.sync_host).toBeNull();
        expect(row.sync_dirty).toBe(1);
      }

      const incremental = snapshot(database);
      rebuildAll(database);
      const rebuilt = snapshot(database);
      rebuildInIdOrder(database);
      const idOrder = snapshot(database);

      expect(rebuilt).toEqual(idOrder);
      expect(incremental).toEqual(idOrder);
      expect(database.query("SELECT title FROM sagas").get()).toEqual({ title: "four" });
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("EventStore uid", () => {
  test("append tags the event with the local host from sync_local and leaves it dirty", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    const event = new EventStore(database).append({
      actor: "hero",
      kind: "hero.created",
      subject: "H1",
      payload: { name: "S" },
    });
    expect(event.uid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(event.syncHost).toBe("host-a");
    expect(event.syncDirty).toBe(true);
  });

  test("a new uid sorts after a stored uid that is ahead of this clock", () => {
    const database = openDatabase(":memory:");
    const future = ulidAt("2099-01-01T00:00:00.000Z", "ZZZZ");
    insertRaw(database, {
      at: "2026-09-01T00:00:00.000Z",
      recordedAt: "2026-09-01T00:00:00.000Z",
      kind: "hero.created",
      subject: "H0",
      payload: { name: "pulled" },
      uid: future,
    });
    const store = new EventStore(database);
    const first = store.append({
      actor: "hero",
      kind: "hero.created",
      subject: "H1",
      payload: { name: "S" },
    });
    const second = store.append({
      actor: "hero",
      kind: "hero.created",
      subject: "H2",
      payload: { name: "S" },
    });
    expect((first.uid as string) > future).toBe(true);
    expect(decodeTime(first.uid as string)).toBe(Date.parse("2099-01-01T00:00:00.000Z"));
    expect((second.uid as string) > (first.uid as string)).toBe(true);
    expect(store.read().map((event) => event.subject)).toEqual(["H0", "H1", "H2"]);
  });

  test("two connections appending in turn keep uid order equal to id order", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    try {
      const one = openDatabase(path);
      const two = openDatabase(path);
      const stores = [new EventStore(one), new EventStore(two)];
      for (let index = 0; index < 50; index++) {
        (stores[index % 2] as EventStore).append({
          actor: "hook",
          kind: "hero.created",
          subject: `H${index}`,
          payload: { name: "S" },
        });
      }
      const rows = one.query("SELECT id, uid, subject FROM events ORDER BY id").all() as {
        id: number;
        uid: string;
        subject: string;
      }[];
      expect(rows).toHaveLength(50);
      expect([...rows].sort((a, b) => (a.uid < b.uid ? -1 : 1)).map((row) => row.id)).toEqual(
        rows.map((row) => row.id),
      );
      one.close();
      two.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("read replays by uid, not by local id: same recorded_at, pulled rows interleave", () => {
    const database = openDatabase(":memory:");
    const recordedAt = "2026-09-01T10:00:00.000Z";
    // Arrival (id) order: C, A, B. Origin (uid) order: A, B, C.
    for (const [subject, random] of [
      ["C", "3"],
      ["A", "1"],
      ["B", "2"],
    ] as const) {
      insertRaw(database, {
        at: recordedAt,
        recordedAt,
        kind: "hero.created",
        subject,
        payload: { name: subject },
        uid: ulidAt(recordedAt, random),
      });
    }
    expect(new EventStore(database).read().map((event) => event.subject)).toEqual(["A", "B", "C"]);
  });

  test("stateAsOf copies uid, sync_host and sync_dirty and keeps uid order", () => {
    const database = openDatabase(":memory:", { hostSlug: "host-a" });
    const recordedAt = "2026-09-01T10:00:00.000Z";
    insertRaw(database, {
      at: recordedAt,
      recordedAt,
      kind: "saga.created",
      subject: "G1",
      payload: { owner: { kind: "hero", id: "H1" }, title: "late uid" },
      uid: ulidAt(recordedAt, "9"),
      syncHost: "host-b",
    });
    insertRaw(database, {
      at: recordedAt,
      recordedAt,
      kind: "saga.reworded",
      subject: "G1",
      payload: { title: "never wins" },
      uid: ulidAt(recordedAt, "1"),
      syncHost: "host-c",
    });
    new EventStore(database).append({
      at: recordedAt,
      actor: "hero",
      kind: "saga.reworded",
      subject: "G1",
      payload: { title: "local" },
    });
    const source = new EventStore(database).read();
    const copy = stateAsOf(database, "2026-12-31T00:00:00.000Z");
    const copied = new EventStore(copy).read();
    const shape = (event: EventRecord) => [
      event.uid,
      event.syncHost,
      event.syncDirty,
      event.subject,
    ];
    expect(copied.map(shape)).toEqual(source.map(shape));
    expect(copied.map((event) => event.syncHost)).toEqual(["host-c", "host-b", "host-a"]);
    expect(copy.query("SELECT title FROM sagas").get()).toEqual({ title: "local" });
    copy.close();
  });
});
