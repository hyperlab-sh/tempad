import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeTime, encodeTime } from "ulid";
import { openDatabase } from "../../src/db/database";
import { isUlid, ulidAfter } from "../../src/intent/ids";
import { EventStore } from "../../src/intent/store";

const CORE = resolve(import.meta.dir, "../..");
const FUTURE = "2099-01-01T00:00:00.000Z";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "tempad-uid-successor-"));
}

/** A ULID at a given time with a fixed random half. */
function ulidAt(time: string, random: string): string {
  return `${encodeTime(Date.parse(time), 10)}${random.padStart(16, "0")}`;
}

/** A pulled event from a host whose clock runs ahead: its uid is the table's max. */
function insertFutureEvent(database: Database, uid: string): void {
  database
    .query(
      `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload, uid, sync_host, sync_dirty)
       VALUES (?, ?, 'hero', NULL, 'hero.created', 'H0', '{}', ?, 'host-c', 0)`,
    )
    .run(FUTURE, FUTURE, uid);
}

describe("ulidAfter", () => {
  test("a candidate already past the maximum is returned unchanged", () => {
    const maximum = ulidAt("2026-09-01T00:00:00.000Z", "1");
    const candidate = ulidAt("2026-09-02T00:00:00.000Z", "1");
    expect(ulidAfter(candidate, maximum)).toBe(candidate);
    expect(ulidAfter(candidate, null)).toBe(candidate);
  });

  test("a candidate at or behind the maximum keeps the maximum's time and sorts after it", () => {
    const maximum = ulidAt(FUTURE, "ZZZZ");
    for (const candidate of [maximum, ulidAt("2026-09-01T00:00:00.000Z", "1")]) {
      const next = ulidAfter(candidate, maximum);
      expect(isUlid(next)).toBe(true);
      expect(next > maximum).toBe(true);
      expect(decodeTime(next)).toBe(Date.parse(FUTURE));
    }
  });

  test("the increment is random: two calls behind the same maximum never collide", () => {
    const maximum = ulidAt(FUTURE, "ZZZZ");
    const candidate = ulidAt("2026-09-01T00:00:00.000Z", "1");
    const seen = new Set<string>();
    for (let index = 0; index < 2000; index++) seen.add(ulidAfter(candidate, maximum));
    expect(seen.size).toBe(2000);
  });

  test("the smallest increment is 1 and the largest is 2^64", () => {
    const maximum = ulidAt(FUTURE, "0");
    expect(ulidAfter(maximum, maximum, () => 1n)).toBe(ulidAt(FUTURE, "1"));
    // 2^64 = 16 * 32^12: Crockford digit "G" (16) followed by twelve zeros.
    expect(ulidAfter(maximum, maximum, () => 1n << 64n)).toBe(ulidAt(FUTURE, "G000000000000"));
  });

  test("an increment past the random half carries into the time part", () => {
    const time = Date.parse(FUTURE);
    const maximum = `${encodeTime(time, 10)}ZZZZZZZZZZZZZZZZ`;
    const next = ulidAfter(maximum, maximum, () => 1n);
    expect(next).toBe(`${encodeTime(time + 1, 10)}0000000000000000`);
    expect(next > maximum).toBe(true);
  });

  test("overflowing the 128-bit space is an explicit error, never a wrap", () => {
    const top = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ";
    expect(() => ulidAfter(top, top)).toThrow(/event uid space exhausted/);
    const nearTop = "7ZZZZZZZZZZZZZZZZZZZZZZZZY";
    expect(ulidAfter(nearTop, nearTop, () => 1n)).toBe(top);
    expect(() => ulidAfter(nearTop, nearTop, () => 2n)).toThrow(/event uid space exhausted/);
  });
});

describe("EventStore uid successor", () => {
  test("two hosts behind the same future maximum, in separate processes, mint distinct uids", () => {
    const directory = temporaryDirectory();
    const future = ulidAt(FUTURE, "ZZZZ");
    try {
      for (const host of ["host-a", "host-b"]) {
        const database = openDatabase(join(directory, `${host}.db`), { hostSlug: host });
        insertFutureEvent(database, future);
        database.close();
      }
      const appendIn = (host: string): string => {
        const code = `
          const { openDatabase } = await import(${JSON.stringify(join(CORE, "src/db/database.ts"))});
          const { EventStore } = await import(${JSON.stringify(join(CORE, "src/intent/store.ts"))});
          const database = openDatabase(${JSON.stringify(join(directory, `${host}.db`))}, { hostSlug: ${JSON.stringify(host)} });
          const event = new EventStore(database).append({ actor: "hero", kind: "hero.created", subject: ${JSON.stringify(`from-${host}`)}, payload: { name: "S" } });
          console.log(event.uid);
          database.close();
        `;
        const result = Bun.spawnSync([process.execPath, "-e", code], { cwd: CORE, env: process.env });
        expect(result.exitCode).toBe(0);
        return result.stdout.toString().trim();
      };
      const fromA = appendIn("host-a");
      const fromB = appendIn("host-b");
      expect(isUlid(fromA)).toBe(true);
      expect(isUlid(fromB)).toBe(true);
      expect(fromA > future).toBe(true);
      expect(fromB > future).toBe(true);
      expect(fromA).not.toBe(fromB);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("many appends behind a future maximum are unique and strictly increasing in id order", () => {
    const database = openDatabase(":memory:");
    const future = ulidAt(FUTURE, "ZZZZ");
    insertFutureEvent(database, future);
    const store = new EventStore(database);
    for (let index = 0; index < 500; index++) {
      store.append({ actor: "hook", kind: "hero.created", subject: `H${index}`, payload: {} });
    }
    const uids = (
      database.query("SELECT uid FROM events ORDER BY id").all() as { uid: string }[]
    ).map((row) => row.uid);
    expect(uids).toHaveLength(501);
    expect(new Set(uids).size).toBe(501);
    for (let index = 1; index < uids.length; index++) {
      expect((uids[index] as string) > (uids[index - 1] as string)).toBe(true);
    }
    // Still anchored to the future host's clock: a random increment of at
    // most 2^64 per append, 500 times, never reaches the next millisecond's
    // 2^80 boundary in practice, but the order holds even if it did.
    expect(decodeTime(uids.at(-1) as string)).toBeGreaterThanOrEqual(Date.parse(FUTURE));
    database.close();
  });
});
