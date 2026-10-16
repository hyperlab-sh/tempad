import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../../src/db/database";
import { ensureTables, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";

registerAllProjections();

const CORE = resolve(import.meta.dir, "../..");

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "tempad-rebuild-lock-"));
}

function heroCount(database: ReturnType<typeof openDatabase>): number {
  return (database.query("SELECT COUNT(*) AS n FROM heroes").get() as { n: number }).n;
}

describe("rebuildAll holds the write lock across its read", () => {
  test("an event committed by another process while the rebuild waits for the lock is replayed", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    const ready = join(directory, "ready");
    try {
      const database = openDatabase(path);
      rebuildAll(database);
      expect(heroCount(database)).toBe(0);

      // The other process takes the write lock, appends a hero, signals, and
      // only commits 400 ms later. The rebuild starts inside that window: had
      // it read the events before taking its own lock, it would replay the
      // empty log and stamp projection_state as current anyway.
      const code = `
        const { openDatabase } = await import(${JSON.stringify(join(CORE, "src/db/database.ts"))});
        const { EventStore } = await import(${JSON.stringify(join(CORE, "src/intent/store.ts"))});
        const database = openDatabase(${JSON.stringify(path)});
        database.exec("BEGIN IMMEDIATE");
        new EventStore(database).append({ actor: "hero", kind: "hero.created", subject: "H1", payload: { name: "S" } });
        await Bun.write(${JSON.stringify(ready)}, "1");
        Bun.sleepSync(400);
        database.exec("COMMIT");
        database.close();
      `;
      const child = Bun.spawn(["bun", "-e", code], { cwd: CORE, stderr: "pipe" });
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline) throw new Error("writer process never took the lock");
        Bun.sleepSync(10);
      }

      rebuildAll(database);
      expect(heroCount(database)).toBe(1);
      const lastEventId = database
        .query("SELECT DISTINCT last_event_id FROM projection_state")
        .all() as { last_event_id: number }[];
      expect(lastEventId).toEqual([{ last_event_id: 1 }]);
      database.close();
      child.kill();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("rebuildAll beforeCommit", () => {
  function seeded(path: string): ReturnType<typeof openDatabase> {
    const database = openDatabase(path);
    ensureTables(database);
    new EventStore(database).append({
      actor: "hero",
      kind: "hero.created",
      subject: "H1",
      payload: { name: "S" },
    });
    database.exec("CREATE TABLE rebuild_probe (note TEXT)");
    return database;
  }

  test("runs inside the transaction, after the replay, with the write lock held", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    try {
      const database = seeded(path);
      const other = openDatabase(path, { busyTimeoutMs: 50 });
      let heroesSeen = -1;
      rebuildAll(database, {
        beforeCommit(inside) {
          expect(inside).toBe(database);
          expect(inside.inTransaction).toBe(true);
          heroesSeen = heroCount(inside);
          inside.query("INSERT INTO rebuild_probe (note) VALUES ('cleared')").run();
          expect(() =>
            new EventStore(other).append({
              actor: "hook",
              kind: "hero.created",
              subject: "H2",
              payload: { name: "T" },
            }),
          ).toThrow();
        },
      });
      expect(heroesSeen).toBe(1);
      expect(database.inTransaction).toBe(false);
      expect(database.query("SELECT note FROM rebuild_probe").all()).toEqual([{ note: "cleared" }]);
      other.close();
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a throw rolls back the rebuild and the callback's own writes", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "tempad.db");
    try {
      const database = seeded(path);
      // No rebuild has run yet, so the projections are empty and unstamped.
      expect(heroCount(database)).toBe(0);
      expect(() =>
        rebuildAll(database, {
          beforeCommit(inside) {
            inside.query("INSERT INTO rebuild_probe (note) VALUES ('cleared')").run();
            throw new Error("marker write failed");
          },
        }),
      ).toThrow("marker write failed");
      expect(database.inTransaction).toBe(false);
      expect(heroCount(database)).toBe(0);
      expect(database.query("SELECT COUNT(*) AS n FROM projection_state").get()).toEqual({ n: 0 });
      expect(database.query("SELECT COUNT(*) AS n FROM rebuild_probe").get()).toEqual({ n: 0 });

      rebuildAll(database);
      expect(heroCount(database)).toBe(1);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
