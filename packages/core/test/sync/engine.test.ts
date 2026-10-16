import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { isNewer, runSyncEngine, SchemaGateError, type SyncRemote } from "../../src/sync/engine";
import {
  addCommit,
  addMondayItem,
  addPullRequest,
  addRepository,
  addSession,
  FakeRemote,
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
    expect(reseedA.pushed).toEqual({ events: 1, rows: 1, tombstones: 1 });
    const reseedB = await sync(hostB, fresh, "host-b");
    expect(reseedB.reseeded).toBe(true);
    expect(reseedB.pushed.rows).toBe(1);
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
