import { Database as BunDatabase, type Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type RebuildOptions, rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import {
  EventCollisionError,
  isNewer,
  runSyncEngine,
  SchemaGateError,
  type SyncRemote,
} from "../../src/sync/engine";
import {
  addCommit,
  addMondayItem,
  addPullRequest,
  addRepository,
  addSession,
  FakeRemote,
  failingOnWrite,
  intent,
  openHost,
  projectionSnapshot,
  restamp,
  sourceSnapshot,
  temporaryDirectory,
} from "./helpers";

const both = { push: true, pull: true };

function sync(database: Database, remote: SyncRemote, hostSlug: string, extra: object = {}) {
  return runSyncEngine(database, remote, { hostSlug, batchSize: 500, ...both, ...extra });
}

function commitSubject(database: Database, sha: string): string | null {
  return (
    (
      database.query("SELECT subject FROM gh_commits WHERE sha = ?").get(sha) as {
        subject: string;
      } | null
    )?.subject ?? null
  );
}

let directory: string;
let remote: FakeRemote;
let hostA: Database;
let hostB: Database;

beforeEach(() => {
  directory = temporaryDirectory();
  remote = new FakeRemote();
  hostA = openHost(directory, "host-a");
  hostB = openHost(directory, "host-b");
});

afterEach(() => {
  hostA.close();
  hostB.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("conflict rule", () => {
  test("the newer stamp wins regardless of host", () => {
    expect(isNewer(["2026-10-02T00:00:00.000Z", "a"], ["2026-10-01T00:00:00.000Z", "z"])).toBe(
      true,
    );
    expect(isNewer(["2026-10-01T00:00:00.000Z", "z"], ["2026-10-02T00:00:00.000Z", "a"])).toBe(
      false,
    );
  });

  test("an identical stamp is broken by the lexically greater host; equal is not newer", () => {
    const stamp = "2026-10-01T00:00:00.000Z";
    expect(isNewer([stamp, "host-b"], [stamp, "host-a"])).toBe(true);
    expect(isNewer([stamp, "host-a"], [stamp, "host-b"])).toBe(false);
    expect(isNewer([stamp, "host-a"], [stamp, "host-a"])).toBe(false);
  });

  test("a newer remote write beats an older one on the server and locally", async () => {
    addRepository(hostA, "acme/web");
    addCommit(hostA, "c1", "acme/web", "from a");
    addRepository(hostB, "acme/web");
    addCommit(hostB, "c1", "acme/web", "from b");
    restamp(hostA, "gh_commits", "sha = ?", ["c1"], "2026-10-01T10:00:00.002Z");
    restamp(hostB, "gh_commits", "sha = ?", ["c1"], "2026-10-01T10:00:00.001Z");

    await sync(hostB, remote, "host-b");
    await sync(hostA, remote, "host-a");
    await sync(hostB, remote, "host-b");

    expect(commitSubject(hostA, "c1")).toBe("from a");
    expect(commitSubject(hostB, "c1")).toBe("from a");
    expect(sourceSnapshot(hostA)).toEqual(sourceSnapshot(hostB));
  });

  test("on an identical stamp the greater host wins, whichever pushed first", async () => {
    const stamp = "2026-10-01T10:00:00.000Z";
    addRepository(hostA, "acme/web");
    addCommit(hostA, "c1", "acme/web", "from a");
    addRepository(hostB, "acme/web");
    addCommit(hostB, "c1", "acme/web", "from b");
    restamp(hostA, "gh_commits", "sha = ?", ["c1"], stamp);
    restamp(hostB, "gh_commits", "sha = ?", ["c1"], stamp);

    await sync(hostB, remote, "host-b");
    await sync(hostA, remote, "host-a");
    await sync(hostB, remote, "host-b");

    expect(commitSubject(hostA, "c1")).toBe("from b");
    expect(commitSubject(hostB, "c1")).toBe("from b");
    // The tie-won pull put host-b's stamp back rather than restamping locally.
    expect(
      hostA.query("SELECT sync_host, sync_updated_at, sync_dirty FROM gh_commits").get(),
    ).toEqual({
      sync_host: "host-b",
      sync_updated_at: stamp,
      sync_dirty: 0,
    });
  });

  test("a delete beats an older write, and the pulled tombstone is not pushed back", async () => {
    addRepository(hostA, "acme/web");
    addCommit(hostA, "c1", "acme/web", "original");
    await sync(hostA, remote, "host-a");
    await sync(hostB, remote, "host-b");
    expect(commitSubject(hostB, "c1")).toBe("original");

    restamp(hostB, "gh_commits", "sha = ?", ["c1"], "2026-01-01T00:00:00.000Z"); // older edit on B
    hostB.query("UPDATE gh_commits SET subject = 'edited on b' WHERE sha = 'c1'").run();
    restamp(hostB, "gh_commits", "sha = ?", ["c1"], "2026-01-01T00:00:00.000Z");
    hostA.query("DELETE FROM gh_commits WHERE sha = 'c1'").run();

    await sync(hostA, remote, "host-a");
    const summary = await sync(hostB, remote, "host-b");
    await sync(hostA, remote, "host-a");

    expect(commitSubject(hostA, "c1")).toBeNull();
    expect(commitSubject(hostB, "c1")).toBeNull();
    expect(summary.pulled.tombstones).toBe(1);
    const tombstoneA = hostA.query("SELECT deleted_at, sync_host FROM sync_tombstones").get();
    expect(
      hostB.query("SELECT deleted_at, sync_host, sync_dirty FROM sync_tombstones").get(),
    ).toEqual({
      ...(tombstoneA as object),
      sync_dirty: 0,
    });
    const again = await sync(hostB, remote, "host-b");
    expect(again.pushed).toEqual({ events: 0, rows: 0, tombstones: 0 });
  });

  test("a newer write beats a delete, and clears the losing local tombstone", async () => {
    addRepository(hostA, "acme/web");
    addCommit(hostA, "c1", "acme/web", "original");
    await sync(hostA, remote, "host-a");
    await sync(hostB, remote, "host-b");

    hostA.query("DELETE FROM gh_commits WHERE sha = 'c1'").run();
    hostB.query("UPDATE gh_commits SET subject = 'kept on b' WHERE sha = 'c1'").run();
    restamp(hostB, "gh_commits", "sha = ?", ["c1"], "2999-01-01T00:00:00.000Z");

    await sync(hostA, remote, "host-a");
    await sync(hostB, remote, "host-b");
    await sync(hostA, remote, "host-a");

    expect(commitSubject(hostA, "c1")).toBe("kept on b");
    expect(commitSubject(hostB, "c1")).toBe("kept on b");
    expect(hostA.query("SELECT COUNT(*) AS n FROM sync_tombstones").get()).toEqual({ n: 0 });
  });

  test("a local dirty row loses to a newer pulled row, and wins over an older one", async () => {
    addRepository(hostA, "acme/web");
    addCommit(hostA, "c1", "acme/web", "a v1");
    addCommit(hostA, "c2", "acme/web", "a v1");
    restamp(hostA, "gh_commits", "sha = ?", ["c1"], "2026-10-01T00:00:00.000Z");
    restamp(hostA, "gh_commits", "sha = ?", ["c2"], "2026-10-01T00:00:00.000Z");
    await sync(hostA, remote, "host-a");
    await sync(hostB, remote, "host-b");

    // A edits both again, newer than B's pending edits on c1 and older on c2.
    hostA.query("UPDATE gh_commits SET subject = 'a v2'").run();
    restamp(hostA, "gh_commits", "sha = ?", ["c1"], "2026-10-03T00:00:00.000Z");
    restamp(hostA, "gh_commits", "sha = ?", ["c2"], "2026-10-02T00:00:00.000Z");
    await sync(hostA, remote, "host-a");

    hostB.query("UPDATE gh_commits SET subject = 'b dirty'").run();
    restamp(hostB, "gh_commits", "sha = ?", ["c1"], "2026-10-02T12:00:00.000Z");
    restamp(hostB, "gh_commits", "sha = ?", ["c2"], "2026-10-02T12:00:00.000Z");

    await runSyncEngine(hostB, remote, {
      hostSlug: "host-b",
      batchSize: 500,
      push: false,
      pull: true,
    });

    expect(
      hostB.query("SELECT sha, subject, sync_dirty FROM gh_commits ORDER BY sha").all(),
    ).toEqual([
      { sha: "c1", subject: "a v2", sync_dirty: 0 },
      { sha: "c2", subject: "b dirty", sync_dirty: 1 },
    ]);
  });
});

describe("two hosts", () => {
  async function seedBoth(): Promise<void> {
    await intent(hostA, ["hero", "init", "Saulo"]);
    await intent(hostA, ["party", "add", "acme", "Acme"]);
    addRepository(hostA, "acme/web", '{"a":1}');
    addCommit(hostA, "c1", "acme/web", "first");
    addCommit(hostA, "c-gone", "acme/web", "to be deleted");
    addPullRequest(hostA, "acme/web", 7, "PR from a");
    addSession(hostA, "s-a", "host-a", ["m-a1", "m-a2"]);

    await intent(hostB, ["hero", "init", "Saulo on b"]);
    await intent(hostB, ["party", "add", "acme", "Acme"]);
    addRepository(hostB, "acme/web", '{"b":1}');
    addRepository(hostB, "acme/api");
    addCommit(hostB, "c2", "acme/api", "second");
    addMondayItem(hostB, 42, "Ship it");
    addSession(hostB, "s-b", "host-b", ["m-b1"]);
  }

  test("push and pull both ways converge source tables and projections", async () => {
    await seedBoth();
    await sync(hostA, remote, "host-a");
    hostA.query("DELETE FROM gh_commits WHERE sha = 'c-gone'").run();
    await sync(hostB, remote, "host-b");
    await sync(hostA, remote, "host-a");
    await sync(hostB, remote, "host-b");

    expect(sourceSnapshot(hostA)).toEqual(sourceSnapshot(hostB));
    expect(commitSubject(hostB, "c-gone")).toBeNull();
    expect(projectionSnapshot(hostA)).toEqual(projectionSnapshot(hostB));
    expect(hostA.query("SELECT COUNT(*) AS n FROM claude_messages").get()).toEqual({ n: 3 });
    expect(hostA.query("SELECT COUNT(*) AS n FROM events").get()).toEqual(
      hostB.query("SELECT COUNT(*) AS n FROM events").get() as object,
    );
  });

  test("a second sync is a no-op locally and remotely", async () => {
    await seedBoth();
    await sync(hostA, remote, "host-a");
    await sync(hostB, remote, "host-b");
    await sync(hostA, remote, "host-a");

    const clock = remote.clock();
    const before = { a: sourceSnapshot(hostA), b: sourceSnapshot(hostB) };
    for (const [database, slug] of [
      [hostA, "host-a"],
      [hostB, "host-b"],
    ] as const) {
      const summary = await sync(database, remote, slug);
      expect(summary.pushed).toEqual({ events: 0, rows: 0, tombstones: 0 });
      expect(summary.pulled).toEqual({ events: 0, rows: 0, tombstones: 0 });
      expect(summary.rebuilt).toBe(false);
    }
    expect(remote.clock()).toBe(clock);
    expect(sourceSnapshot(hostA)).toEqual(before.a);
    expect(sourceSnapshot(hostB)).toEqual(before.b);
  });

  test("a pull that inserts events rebuilds; one that inserts none does not", async () => {
    await intent(hostA, ["hero", "init", "Saulo"]);
    await sync(hostA, remote, "host-a");
    const first = await sync(hostB, remote, "host-b");
    expect(first.pulled.events).toBe(1);
    expect(first.rebuilt).toBe(true);
    expect(hostB.query("SELECT name FROM heroes").all()).toEqual([{ name: "Saulo" }]);
  });

  test("host-local columns are not pushed and never overwritten by a pull", async () => {
    addRepository(hostA, "acme/web");
    await sync(hostA, remote, "host-a");
    const pushed = remote.database
      .query("SELECT data FROM sync_rows WHERE tbl = 'gh_repos'")
      .get() as {
      data: string;
    };
    expect(Object.keys(JSON.parse(pushed.data))).not.toContain("mirrored_at");

    await sync(hostB, remote, "host-b");
    expect(hostB.query("SELECT mirrored_at FROM gh_repos").get()).toEqual({ mirrored_at: null });

    hostB.query("UPDATE gh_repos SET mirrored_at = '2026-10-05T00:00:00.000Z'").run();
    hostA.query("UPDATE gh_repos SET meta = '{\"changed\":true}'").run();
    await sync(hostA, remote, "host-a");
    await sync(hostB, remote, "host-b");
    expect(hostB.query("SELECT meta, mirrored_at FROM gh_repos").get()).toEqual({
      meta: '{"changed":true}',
      mirrored_at: "2026-10-05T00:00:00.000Z",
    });
  });

  test("a pulled column the local schema lacks is dropped", async () => {
    addRepository(hostA, "acme/web");
    await sync(hostA, remote, "host-a");
    const row = remote.database
      .query("SELECT data FROM sync_rows WHERE tbl = 'gh_repos'")
      .get() as {
      data: string;
    };
    remote.database
      .query("UPDATE sync_rows SET data = ? WHERE tbl = 'gh_repos'")
      .run(JSON.stringify({ ...JSON.parse(row.data), from_the_future: 1 }));

    const summary = await sync(hostB, remote, "host-b");
    expect(summary.pulled.rows).toBe(1);
    expect(hostB.query("SELECT full_name FROM gh_repos").all()).toEqual([
      { full_name: "acme/web" },
    ]);
  });
});

describe("failures and identity", () => {
  test("a push that fails after its first batch resumes from what is still dirty", async () => {
    await sync(hostA, remote, "host-a"); // first contact: the server is known from here on
    addRepository(hostA, "acme/web");
    for (let index = 0; index < 5; index += 1)
      addCommit(hostA, `c${index}`, "acme/web", `commit ${index}`);
    // Next writes: the remote schema, gh_repos, the first commit batch, then fail.
    remote.failOnWrite = remote.writes + 4;
    await expect(
      runSyncEngine(hostA, remote, { hostSlug: "host-a", batchSize: 2, ...both }),
    ).rejects.toThrow("injected remote failure");

    expect(hostA.query("SELECT COUNT(*) AS n FROM gh_commits WHERE sync_dirty = 0").get()).toEqual({
      n: 2,
    });
    expect(
      remote.database.query("SELECT COUNT(*) AS n FROM sync_rows WHERE tbl = 'gh_commits'").get(),
    ).toEqual({
      n: 2,
    });

    remote.failOnWrite = undefined;
    const resumed = await runSyncEngine(hostA, remote, {
      hostSlug: "host-a",
      batchSize: 2,
      ...both,
    });
    expect(resumed.pushed.rows).toBe(3);
    await sync(hostB, remote, "host-b");
    expect(sourceSnapshot(hostA)).toEqual(sourceSnapshot(hostB));
  });

  test("the schema gate refuses a host older than the remote", async () => {
    await sync(hostA, remote, "host-a");
    remote.database.query("UPDATE sync_meta SET value = '999' WHERE key = 'schema_version'").run();
    const version = (hostA.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    const attempt = sync(hostA, remote, "host-a");
    await expect(attempt).rejects.toBeInstanceOf(SchemaGateError);
    await expect(sync(hostA, remote, "host-a")).rejects.toThrow(
      `remote holds data from tempad schema 999; upgrade tempad on this host (schema ${version})`,
    );
  });

  test("a newer host raises the remote schema version even on a pull-only run", async () => {
    await sync(hostA, remote, "host-a");
    remote.database.query("UPDATE sync_meta SET value = '3' WHERE key = 'schema_version'").run();
    await runSyncEngine(hostA, remote, {
      hostSlug: "host-a",
      batchSize: 500,
      push: false,
      pull: true,
    });
    const version = (hostA.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    expect(
      remote.database.query("SELECT value FROM sync_meta WHERE key = 'schema_version'").get(),
    ).toEqual({ value: String(version) });
  });

  test("a newer host raises the remote schema version with its push", async () => {
    await sync(hostA, remote, "host-a");
    remote.database.query("UPDATE sync_meta SET value = '3' WHERE key = 'schema_version'").run();
    addRepository(hostA, "acme/web");
    await sync(hostA, remote, "host-a");
    const version = (hostA.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    expect(
      remote.database.query("SELECT value FROM sync_meta WHERE key = 'schema_version'").get(),
    ).toEqual({
      value: String(version),
    });
  });

  test("a server with a new identity is re-seeded from every host and cursors restart", async () => {
    await intent(hostA, ["hero", "init", "Saulo"]);
    addRepository(hostA, "acme/web");
    addCommit(hostA, "c1", "acme/web", "x");
    hostA.query("DELETE FROM gh_commits WHERE sha = 'c1'").run();
    addRepository(hostB, "acme/api");
    await sync(hostA, remote, "host-a");
    await sync(hostB, remote, "host-b");
    await sync(hostA, remote, "host-a");

    const fresh = new FakeRemote();
    const reseedA = await sync(hostA, fresh, "host-a");
    expect(reseedA.reseeded).toBe(true);
    // Every row it holds, B's acme/api included, not only its own.
    expect(reseedA.pushed).toEqual({ events: 1, rows: 2, tombstones: 1 });
    const reseedB = await sync(hostB, fresh, "host-b");
    expect(reseedB.reseeded).toBe(true);
    expect(reseedB.pushed).toEqual({ events: 1, rows: 2, tombstones: 1 });
    expect(fresh.database.query("SELECT COUNT(*) AS n FROM sync_rows").get()).toEqual({ n: 3 });
    expect(fresh.database.query("SELECT COUNT(*) AS n FROM sync_events").get()).toEqual({ n: 1 });

    const settled = await sync(hostA, fresh, "host-a");
    expect(settled.reseeded).toBe(false);
    expect(settled.pushed).toEqual({ events: 0, rows: 0, tombstones: 0 });
    expect(sourceSnapshot(hostA)).toEqual(sourceSnapshot(hostB));
  });

  test("a pull-only run against an unknown server leaves the re-seed to the next push", async () => {
    addRepository(hostA, "acme/web");
    await sync(hostA, remote, "host-a");
    const fresh = new FakeRemote();
    await runSyncEngine(hostA, fresh, {
      hostSlug: "host-a",
      batchSize: 500,
      push: false,
      pull: true,
    });
    const next = await sync(hostA, fresh, "host-a");
    expect(next.reseeded).toBe(true);
    expect(next.pushed.rows).toBe(1);
  });

  test("a parent updated after its child arrives before the child's page is committed", async () => {
    addRepository(hostA, "acme/web");
    addCommit(hostA, "c1", "acme/web", "child");
    addSession(hostA, "s1", "host-a", ["m1"]);
    await runSyncEngine(hostA, remote, { hostSlug: "host-a", batchSize: 1, ...both });
    // The parents move to a later seq than their children.
    hostA.query("UPDATE gh_repos SET meta = '{\"later\":true}'").run();
    hostA.query("UPDATE claude_sessions SET title = 'later'").run();
    await runSyncEngine(hostA, remote, { hostSlug: "host-a", batchSize: 1, ...both });

    const summary = await runSyncEngine(hostB, remote, {
      hostSlug: "host-b",
      batchSize: 1,
      pageSize: 1,
      ...both,
    });
    expect(summary.pulled.rows).toBe(4);
    expect(sourceSnapshot(hostA)).toEqual(sourceSnapshot(hostB));
  });
});

/** Wraps a remote so its `n`th pull page query on `sync_events` throws. */
function failingOnEventsPage(remote: SyncRemote, failOn: number): SyncRemote {
  let pages = 0;
  return {
    async query(sql, args) {
      if (sql.includes("FROM sync_events") && sql.includes("seq > ?")) {
        pages += 1;
        if (pages === failOn) throw new Error("injected pull failure");
      }
      return remote.query(sql, args);
    },
    write: (statements) => remote.write(statements),
    close: () => remote.close(),
  };
}

function rebuildPending(database: Database): boolean {
  return database.query("SELECT 1 FROM sync_meta WHERE key = 'rebuild_pending'").get() !== null;
}

function eventCount(database: Database): number {
  return (database.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
}

describe("partial pull and stale projections", () => {
  beforeEach(async () => {
    directory = temporaryDirectory();
    remote = new FakeRemote();
    hostA = openHost(directory, "host-a");
    hostB = openHost(directory, "host-b");
    await intent(hostA, ["hero", "init", "Saulo"]);
    await intent(hostA, ["party", "add", "acme", "Acme"]);
    await intent(hostA, ["saga", "add", "--owner", "hero", "Ship push sync"]);
    // One event per batch, so each event has its own seq and its own page.
    await sync(hostA, remote, "host-a", { batchSize: 1 });
  });

  afterEach(() => {
    hostA.close();
    hostB.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("a pull that fails on a later page leaves a marker, and a push-only run rebuilds", async () => {
    const pullOnly = { hostSlug: "host-b", batchSize: 500, pageSize: 1, push: false, pull: true };
    await expect(runSyncEngine(hostB, failingOnEventsPage(remote, 2), pullOnly)).rejects.toThrow(
      "injected pull failure",
    );
    expect(eventCount(hostB)).toBe(1);
    expect(rebuildPending(hostB)).toBe(true);

    const pushOnly = await runSyncEngine(hostB, remote, {
      hostSlug: "host-b",
      batchSize: 500,
      push: true,
      pull: false,
    });
    expect(pushOnly.rebuilt).toBe(true);
    expect(pushOnly.pulled.events).toBe(0);
    expect(rebuildPending(hostB)).toBe(false);
    expect(hostB.query("SELECT COUNT(*) AS n FROM heroes").get()).toEqual({ n: 1 });

    const rest = await runSyncEngine(hostB, remote, { ...pullOnly, pull: true });
    expect(rest.rebuilt).toBe(true);
    expect(projectionSnapshot(hostB)).toEqual(projectionSnapshot(hostA));
    expect(rebuildPending(hostB)).toBe(false);
  });

  test("the next full run after a failed pull rebuilds and matches the source host", async () => {
    const options = { hostSlug: "host-b", batchSize: 500, pageSize: 1, ...both };
    await expect(runSyncEngine(hostB, failingOnEventsPage(remote, 3), options)).rejects.toThrow(
      "injected pull failure",
    );
    const next = await runSyncEngine(hostB, remote, options);
    expect(next.rebuilt).toBe(true);
    expect(projectionSnapshot(hostB)).toEqual(projectionSnapshot(hostA));
    expect(sourceSnapshot(hostB).events).toEqual(sourceSnapshot(hostA).events);
  });

  test("a throw from the rebuild itself keeps the marker until a rebuild succeeds", async () => {
    await expect(
      runSyncEngine(hostB, remote, {
        hostSlug: "host-b",
        batchSize: 500,
        ...both,
        rebuildProjections: () => {
          throw new Error("injected rebuild failure");
        },
      }),
    ).rejects.toThrow("injected rebuild failure");
    expect(rebuildPending(hostB)).toBe(true);
    expect(eventCount(hostB)).toBe(eventCount(hostA));

    const next = await sync(hostB, remote, "host-b");
    expect(next.pulled.events).toBe(0);
    expect(next.rebuilt).toBe(true);
    expect(rebuildPending(hostB)).toBe(false);
    expect(projectionSnapshot(hostB)).toEqual(projectionSnapshot(hostA));

    const quiet = await sync(hostB, remote, "host-b");
    expect(quiet.rebuilt).toBe(false);
  });

  test("a pulled event that violates a constraint rolls its page back and holds the cursor", async () => {
    const seq = remote.clock() + 1;
    remote.database.query("UPDATE sync_clock SET seq = ?").run(seq);
    remote.database
      .query("INSERT INTO sync_events (uid, data, sync_host, seq) VALUES (?, ?, 'host-a', ?)")
      .run(
        "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
        JSON.stringify({
          at: "2026-10-01T00:00:00.000Z",
          recorded_at: "x",
          actor: "hero",
          subject: "s",
          payload: "{}",
        }),
        seq,
      );
    const options = { hostSlug: "host-b", batchSize: 500, pageSize: 1, push: false, pull: true };
    await expect(runSyncEngine(hostB, remote, options)).rejects.toThrow(/NOT NULL/);
    expect(eventCount(hostB)).toBe(eventCount(hostA));
    const cursor = hostB.query("SELECT seq FROM sync_cursors WHERE stream = 'events'").get() as {
      seq: number;
    };
    expect(cursor.seq).toBe(seq - 1);
    // Still stuck on it: the bad event is never skipped.
    await expect(runSyncEngine(hostB, remote, options)).rejects.toThrow(/NOT NULL/);
  });
});

describe("re-seed from a surviving host", () => {
  test("a fresh fourth host converges to every host's data after one host re-seeds", async () => {
    const root = temporaryDirectory();
    const server = new FakeRemote();
    const a = openHost(root, "host-a");
    const b = openHost(root, "host-b");
    const c = openHost(root, "host-c");
    try {
      await intent(a, ["hero", "init", "Saulo"]);
      await intent(b, ["hero", "init", "Saulo"]);
      await intent(b, ["party", "add", "acme", "Acme"]);
      await intent(c, ["hero", "init", "Saulo"]);
      await intent(c, ["party", "add", "acme", "Acme"]);
      addRepository(a, "acme/web");
      addCommit(a, "a1", "acme/web", "from a");
      addRepository(b, "acme/api");
      addPullRequest(b, "acme/api", 7, "from b");
      addMondayItem(c, 42, "from c");
      addRepository(c, "acme/ops");
      addCommit(c, "gone", "acme/ops", "deleted on c");
      for (const [host, slug] of [
        [a, "host-a"],
        [b, "host-b"],
        [c, "host-c"],
      ] as const)
        await sync(host, server, slug);
      c.query("DELETE FROM gh_commits WHERE sha = 'gone'").run();
      await sync(c, server, "host-c");
      for (const [host, slug] of [
        [a, "host-a"],
        [b, "host-b"],
        [c, "host-c"],
      ] as const)
        await sync(host, server, slug);
      expect(sourceSnapshot(a)).toEqual(sourceSnapshot(c));

      // The server is lost; B and C are retired. Only A re-seeds.
      const replacement = new FakeRemote();
      const reseed = await sync(a, replacement, "host-a");
      expect(reseed.reseeded).toBe(true);

      const d = openHost(root, "host-d");
      try {
        const fresh = await sync(d, replacement, "host-d");
        expect(fresh.rebuilt).toBe(true);
        expect(sourceSnapshot(d)).toEqual(sourceSnapshot(a));
        expect(projectionSnapshot(d)).toEqual(projectionSnapshot(a));
        expect(d.query("SELECT COUNT(*) AS n FROM sync_tombstones").get()).toEqual({ n: 1 });
        // Idempotent: a second re-seed-sized push changes nothing remotely.
        const clock = replacement.clock();
        await sync(a, replacement, "host-a");
        expect(replacement.clock()).toBe(clock);
      } finally {
        d.close();
      }
    } finally {
      a.close();
      b.close();
      c.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** The server as it was at `backup`: same `server_id`, older clock and data. */
function restore(backup: Uint8Array): FakeRemote {
  const restored = new FakeRemote();
  (restored as { database: Database }).database = BunDatabase.deserialize(backup);
  return restored;
}

function count(database: Database, sql: string): number {
  return (database.query(sql).get() as { n: number }).n;
}

describe("a server restored from a backup that kept its id", () => {
  let root: string;
  let server: FakeRemote;
  let a: Database;
  let b: Database;
  let c: Database;
  const one = (database: Database, remote: SyncRemote, hostSlug: string, extra: object = {}) =>
    runSyncEngine(database, remote, { hostSlug, batchSize: 1, ...both, ...extra });

  beforeEach(() => {
    root = temporaryDirectory();
    server = new FakeRemote();
    a = openHost(root, "host-a");
    b = openHost(root, "host-b");
    c = openHost(root, "host-c");
  });

  afterEach(() => {
    a.close();
    b.close();
    c.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** A and B write after the backup; returns the restored server. */
  async function backupThenWrite(): Promise<FakeRemote> {
    addRepository(a, "acme/web");
    await intent(a, ["hero", "init", "Saulo"]);
    await one(a, server, "host-a");
    const backup = server.database.serialize();
    for (let index = 0; index < 6; index++) addCommit(a, `c${index}`, "acme/web", `s${index}`);
    await intent(a, ["party", "add", "acme", "Acme"]);
    for (let index = 0; index < 10; index++) addMondayItem(b, index, `m${index}`);
    await one(a, server, "host-a");
    await one(b, server, "host-b");
    await one(a, server, "host-a");
    return restore(backup);
  }

  /** Everyone settles, then a fresh host must hold exactly what A holds. */
  async function expectFourthHostConverges(restored: FakeRemote, hosts: [Database, string][]) {
    for (let round = 0; round < 2; round++) {
      for (const [host, slug] of hosts) await one(host, restored, slug);
    }
    const d = openHost(root, "host-d");
    try {
      await one(d, restored, "host-d");
      for (const [host] of hosts) expect(sourceSnapshot(host)).toEqual(sourceSnapshot(a));
      expect(sourceSnapshot(d)).toEqual(sourceSnapshot(a));
      expect(projectionSnapshot(d)).toEqual(projectionSnapshot(a));
    } finally {
      d.close();
    }
  }

  test("P1: a pull-only run first does not cancel the re-seed", async () => {
    const restored = await backupThenWrite();
    const pullOnly = await one(a, restored, "host-a", { push: false });
    expect(pullOnly.reseeded).toBe(false);
    expect(
      a.query("SELECT value FROM sync_meta WHERE key = 'reseed_pending'").get(),
    ).not.toBeNull();
    // Again pull-only: still pending, still not trusting the cursors.
    await one(a, restored, "host-a", { push: false });
    const next = await one(a, restored, "host-a");
    expect(next.reseeded).toBe(true);
    expect(
      count(restored.database, "SELECT COUNT(*) AS n FROM sync_rows WHERE tbl = 'gh_commits'"),
    ).toBe(6);
    expect(a.query("SELECT value FROM sync_meta WHERE key = 'reseed_pending'").get()).toBeNull();
    await expectFourthHostConverges(restored, [
      [a, "host-a"],
      [b, "host-b"],
    ]);
  });

  test("P2: a re-seed interrupted part-way resumes in full on the next run", async () => {
    const restored = await backupThenWrite();
    await expect(one(a, failingOnWrite(restored, 6), "host-a")).rejects.toThrow(
      "injected remote failure",
    );
    expect(
      a.query("SELECT value FROM sync_meta WHERE key = 'reseed_pending'").get(),
    ).not.toBeNull();
    const next = await one(a, restored, "host-a");
    expect(next.reseeded).toBe(true);
    // A holds B's monday rows too, so A alone restores them.
    expect(
      count(restored.database, "SELECT COUNT(*) AS n FROM sync_rows WHERE tbl = 'monday_items'"),
    ).toBe(10);
    await expectFourthHostConverges(restored, [
      [a, "host-a"],
      [b, "host-b"],
    ]);
  });

  test("P4: another host writing first after the restore does not hide it", async () => {
    const restored = await backupThenWrite();
    const cursor = count(a, "SELECT MAX(seq) AS n FROM sync_cursors");
    for (let index = 200; index < 200 + cursor + 2; index++) addMondayItem(c, index, `c${index}`);
    await one(c, restored, "host-c");
    expect(restored.clock()).toBeGreaterThan(cursor);

    const reseedA = await one(a, restored, "host-a");
    expect(reseedA.reseeded).toBe(true);
    const reseedB = await one(b, restored, "host-b");
    expect(reseedB.reseeded).toBe(true);
    expect(count(a, "SELECT COUNT(*) AS n FROM monday_items WHERE id >= 200")).toBe(cursor + 2);
    await expectFourthHostConverges(restored, [
      [a, "host-a"],
      [b, "host-b"],
      [c, "host-c"],
    ]);
  });

  test("detection rotates the server id once and every host settles", async () => {
    const restored = await backupThenWrite();
    const before = restored.database
      .query("SELECT value FROM sync_meta WHERE key = 'server_id'")
      .get() as { value: string };
    // A and B both see the loss (each one's last push is gone).
    expect((await one(a, restored, "host-a", { push: false })).reseeded).toBe(false);
    expect((await one(b, restored, "host-b", { push: false })).reseeded).toBe(false);
    const after = restored.database
      .query("SELECT value FROM sync_meta WHERE key = 'server_id'")
      .get() as { value: string };
    expect(after.value).not.toBe(before.value);
    expect((await one(a, restored, "host-a")).reseeded).toBe(true);
    expect((await one(b, restored, "host-b")).reseeded).toBe(true);
    expect((await one(c, restored, "host-c")).reseeded).toBe(true);
    for (const [host, slug] of [
      [a, "host-a"],
      [b, "host-b"],
      [c, "host-c"],
    ] as const) {
      expect((await one(host, restored, slug)).reseeded).toBe(false);
    }
    expect(
      (
        restored.database.query("SELECT value FROM sync_meta WHERE key = 'server_id'").get() as {
          value: string;
        }
      ).value,
    ).toBe(after.value);
    expect(sourceSnapshot(b)).toEqual(sourceSnapshot(a));
    expect(sourceSnapshot(c)).toEqual(sourceSnapshot(a));
  });

  test("a lost event is detected even when the clock moved past every cursor", async () => {
    await intent(a, ["hero", "init", "Saulo"]);
    await one(a, server, "host-a");
    const backup = server.database.serialize();
    await intent(a, ["party", "add", "acme", "Acme"]);
    await one(a, server, "host-a");
    const restored = restore(backup);
    // Push the restored clock far ahead from another host.
    for (let index = 0; index < 20; index++) addMondayItem(c, index, `c${index}`);
    await one(c, restored, "host-c");
    const next = await one(a, restored, "host-a");
    expect(next.reseeded).toBe(true);
    expect(count(restored.database, "SELECT COUNT(*) AS n FROM sync_events")).toBe(
      count(a, "SELECT COUNT(*) AS n FROM events"),
    );
  });
});

test("a mirror row whose rowid is 0 or negative is pushed", async () => {
  const root = temporaryDirectory();
  const server = new FakeRemote();
  const source = openHost(root, "host-a");
  const target = openHost(root, "host-b");
  try {
    addMondayItem(source, 0, "zero");
    addMondayItem(source, -5, "negative");
    addMondayItem(source, 3, "positive");
    await runSyncEngine(source, server, { hostSlug: "host-a", batchSize: 1, ...both });
    await runSyncEngine(target, server, { hostSlug: "host-b", batchSize: 1, ...both });
    expect(count(source, "SELECT COUNT(*) AS n FROM monday_items WHERE sync_dirty = 1")).toBe(0);
    expect(sourceSnapshot(target).monday_items).toHaveLength(3);
  } finally {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("rebuild failures and markers", () => {
  beforeEach(() => {
    directory = temporaryDirectory();
    remote = new FakeRemote();
    hostA = openHost(directory, "host-a");
    hostB = openHost(directory, "host-b");
  });

  afterEach(() => {
    hostA.close();
    hostB.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("P9: a rebuild that keeps failing still lets push and pull run, then fails the run", async () => {
    await intent(hostA, ["hero", "init", "Saulo"]);
    await sync(hostA, remote, "host-a");
    const boom = () => {
      throw new Error("reducer boom");
    };
    await expect(sync(hostB, remote, "host-b", { rebuildProjections: boom })).rejects.toThrow(
      "reducer boom",
    );
    addMondayItem(hostB, 7, "new local work");
    const warnings: string[] = [];
    await expect(
      sync(hostB, remote, "host-b", {
        rebuildProjections: boom,
        pull: false,
        warn: (message: string) => warnings.push(message),
      }),
    ).rejects.toThrow("reducer boom");
    expect(warnings).toEqual([
      "sync: projection rebuild failed, retrying after push and pull: reducer boom",
    ]);
    expect(
      count(remote.database, "SELECT COUNT(*) AS n FROM sync_rows WHERE tbl = 'monday_items'"),
    ).toBe(1);
    expect(
      hostB.query("SELECT 1 FROM sync_meta WHERE key = 'rebuild_pending'").get(),
    ).not.toBeNull();
    const healed = await sync(hostB, remote, "host-b");
    expect(healed.rebuilt).toBe(true);
    expect(projectionSnapshot(hostB)).toEqual(projectionSnapshot(hostA));
  });

  test("a marker set again during a rebuild survives that rebuild's clear", async () => {
    await intent(hostA, ["hero", "init", "Saulo"]);
    await sync(hostA, remote, "host-a");
    await expect(
      sync(hostB, remote, "host-b", {
        rebuildProjections: () => {
          throw new Error("first rebuild fails");
        },
      }),
    ).rejects.toThrow("first rebuild fails");
    const before = hostB.query("SELECT value FROM sync_meta WHERE key = 'rebuild_pending'").get();
    let calls = 0;
    const summary = await sync(hostB, remote, "host-b", {
      pull: false,
      rebuildProjections: (database: Database, options: RebuildOptions) => {
        // A concurrent sync pulls a page and sets a fresh marker meanwhile.
        calls += 1;
        database
          .query("UPDATE sync_meta SET value = ? WHERE key = 'rebuild_pending'")
          .run(`concurrent-${calls}`);
        options.beforeCommit?.(database);
      },
    });
    // The first rebuild's clear misses (token changed), so the end-of-run
    // rebuild runs again, and its clear misses the next renewal too.
    const renewed = `concurrent-${calls}`;
    expect(calls).toBe(2);
    expect(summary.rebuilt).toBe(true);
    expect(before).not.toBeNull();
    expect(hostB.query("SELECT value FROM sync_meta WHERE key = 'rebuild_pending'").get()).toEqual({
      value: renewed,
    });
  });

  test("the marker is cleared inside the rebuild's transaction, so a rollback keeps it", async () => {
    await intent(hostA, ["hero", "init", "Saulo"]);
    await sync(hostA, remote, "host-a");
    const failAtCommit = (database: Database, options: RebuildOptions) => {
      registerAllProjections();
      rebuildAll(database, {
        beforeCommit: (inside) => {
          options.beforeCommit?.(inside);
          // The marker is gone inside the transaction...
          expect(
            inside.query("SELECT 1 FROM sync_meta WHERE key = 'rebuild_pending'").get(),
          ).toBeNull();
          throw new Error("commit fails");
        },
      });
    };
    await expect(
      sync(hostB, remote, "host-b", { rebuildProjections: failAtCommit }),
    ).rejects.toThrow("commit fails");
    // ...and back after the rollback, with the projections still stale.
    expect(
      hostB.query("SELECT 1 FROM sync_meta WHERE key = 'rebuild_pending'").get(),
    ).not.toBeNull();
    expect(projectionSnapshot(hostB)).not.toEqual(projectionSnapshot(hostA));
    expect((await sync(hostB, remote, "host-b")).rebuilt).toBe(true);
    expect(hostB.query("SELECT 1 FROM sync_meta WHERE key = 'rebuild_pending'").get()).toBeNull();
    expect(projectionSnapshot(hostB)).toEqual(projectionSnapshot(hostA));
  });

  test("each pulled page sets a fresh marker token", async () => {
    await intent(hostA, ["hero", "init", "Saulo"]);
    await sync(hostA, remote, "host-a");
    const tokens = new Set<string>();
    for (let round = 0; round < 2; round++) {
      await intent(hostA, ["party", "add", `p${round}`, `P${round}`]);
      await sync(hostA, remote, "host-a");
      await expect(
        sync(hostB, remote, "host-b", {
          rebuildProjections: () => {
            throw new Error("keep the marker");
          },
        }),
      ).rejects.toThrow();
      const row = hostB
        .query("SELECT value FROM sync_meta WHERE key = 'rebuild_pending'")
        .get() as {
        value: string;
      };
      tokens.add(row.value);
    }
    expect(tokens.size).toBe(2);
  });
});

describe("event uid collisions are loud", () => {
  beforeEach(() => {
    directory = temporaryDirectory();
    remote = new FakeRemote();
    hostA = openHost(directory, "host-a");
    hostB = openHost(directory, "host-b");
  });

  afterEach(() => {
    hostA.close();
    hostB.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function firstUid(database: Database): string {
    return (database.query("SELECT uid FROM events ORDER BY uid LIMIT 1").get() as { uid: string })
      .uid;
  }

  function plantRemoteEvent(uid: string, subject: string): void {
    const seq = remote.clock() + 1;
    remote.database.query("UPDATE sync_clock SET seq = ?").run(seq);
    remote.database
      .query("INSERT INTO sync_events (uid, data, sync_host, seq) VALUES (?, ?, 'host-z', ?)")
      .run(
        uid,
        JSON.stringify({
          at: "2026-10-01T00:00:00.000Z",
          recorded_at: "2026-10-01T00:00:00.000Z",
          actor: "hero",
          session_id: null,
          kind: "hero.created",
          subject,
          payload: "{}",
        }),
        seq,
      );
  }

  test("a push whose uid the server holds with other content throws and stays dirty", async () => {
    await sync(hostA, remote, "host-a");
    await intent(hostA, ["hero", "init", "Saulo"]);
    plantRemoteEvent(firstUid(hostA), "someone-else");
    await expect(sync(hostA, remote, "host-a")).rejects.toThrow(EventCollisionError);
    expect(count(hostA, "SELECT COUNT(*) AS n FROM events WHERE sync_dirty = 1")).toBe(1);
    await expect(sync(hostA, remote, "host-a")).rejects.toThrow("different content");
  });

  test("a pulled uid that exists locally with other content throws and holds the cursor", async () => {
    await sync(hostB, remote, "host-b");
    await intent(hostB, ["hero", "init", "Saulo"]);
    plantRemoteEvent(firstUid(hostB), "someone-else");
    const pullOnly = { hostSlug: "host-b", batchSize: 500, push: false, pull: true };
    await expect(runSyncEngine(hostB, remote, pullOnly)).rejects.toThrow(EventCollisionError);
    expect(hostB.query("SELECT seq FROM sync_cursors WHERE stream = 'events'").get()).toBeNull();
    expect(count(hostB, "SELECT COUNT(*) AS n FROM events")).toBe(1);
  });

  test("the same event arriving under its own uid is not a collision", async () => {
    await intent(hostA, ["hero", "init", "Saulo"]);
    await sync(hostA, remote, "host-a");
    await sync(hostB, remote, "host-b");
    // A full re-download and a full re-push both meet identical events.
    const fresh = new FakeRemote();
    await sync(hostA, fresh, "host-a");
    await sync(hostB, fresh, "host-b");
    expect(sourceSnapshot(hostA).events).toEqual(sourceSnapshot(hostB).events);
  });
});
