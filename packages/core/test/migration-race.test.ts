import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";

const DATABASE_MODULE = join(import.meta.dir, "../src/db/database.ts");
const PROCESSES = 4;
const ROUNDS = 5;
const LEGACY_EVENTS = 3000;

/**
 * The child spins until `goAt`, so every process reaches `openDatabase` in the
 * same few milliseconds, then reports whether it opened.
 */
const CHILD = `
const [modulePath, databasePath, goAt, hostSlug] = process.argv.slice(2);
const { openDatabase } = await import(modulePath);
while (Date.now() < Number(goAt));
try {
  const database = openDatabase(databasePath, { hostSlug });
  const version = database.query("PRAGMA user_version").get().user_version;
  database.close();
  console.log(JSON.stringify({ ok: true, version }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
}
`;

function preNineteenDatabase(path: string): void {
  const database = openDatabase(path, { upToVersion: 18 });
  const insert = database.query(
    `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload)
     VALUES (?, ?, 'hero', NULL, 'party.created', ?, ?)`,
  );
  database.transaction(() => {
    for (let index = 0; index < LEGACY_EVENTS; index += 1) {
      const at = new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1000).toISOString();
      insert.run(at, at, `PARTY-${index}`, JSON.stringify({ slug: `p${index}`, name: "P" }));
    }
  })();
  expect(
    (database.query("PRAGMA user_version").get() as { user_version: number }).user_version,
  ).toBe(18);
  database.close();
}

describe("two processes opening a database that needs upgrading", () => {
  test("every process succeeds and the schema is migrated exactly once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-migration-race-"));
    const script = join(directory, "child.ts");
    writeFileSync(script, CHILD);
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        const path = join(directory, `round-${round}.db`);
        preNineteenDatabase(path);
        const goAt = Date.now() + 1500;
        const children = Array.from({ length: PROCESSES }, (_, index) =>
          Bun.spawn(
            [process.execPath, script, DATABASE_MODULE, path, String(goAt), `host-${index}`],
            { stdout: "pipe", stderr: "pipe" },
          ),
        );
        const results = await Promise.all(
          children.map(async (child) => {
            const [out, err] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            await child.exited;
            return { out: out.trim(), err: err.trim() };
          }),
        );
        for (const result of results) {
          expect(result.err).toBe("");
          const parsed = JSON.parse(result.out) as { ok: boolean; error?: string };
          expect(parsed.error).toBeUndefined();
          expect(parsed.ok).toBe(true);
        }

        const database = new Database(path, { readonly: true });
        const latest = openDatabase(join(directory, "fresh.db"));
        const expectedVersion = (
          latest.query("PRAGMA user_version").get() as { user_version: number }
        ).user_version;
        latest.close();
        rmSync(join(directory, "fresh.db"), { force: true });
        expect(
          (database.query("PRAGMA user_version").get() as { user_version: number }).user_version,
        ).toBe(expectedVersion);
        expect(
          database
            .query("SELECT COUNT(*) AS n FROM pragma_table_info('events') WHERE name = 'uid'")
            .get(),
        ).toEqual({ n: 1 });
        expect(database.query("SELECT COUNT(*) AS n FROM events WHERE uid IS NULL").get()).toEqual({
          n: 0,
        });
        expect(database.query("SELECT COUNT(DISTINCT uid) AS n FROM events").get()).toEqual({
          n: LEGACY_EVENTS,
        });
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
