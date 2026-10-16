import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { ForgottenServerError, runSyncEngine } from "../../src/sync/engine";
import { forgetSync, rejoinServer, UnpushedChangesError } from "../../src/sync/forget";
import {
  enableMirrorSync,
  isMirrorSyncEnabled,
  MIRROR_TRIGGER_NAMES,
} from "../../src/sync/triggers";
import {
  addCommit,
  addMondayItem,
  addPullRequest,
  addRepository,
  addSession,
  FakeRemote,
  intent,
  sourceSnapshot,
  temporaryDirectory,
} from "./helpers";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const both = { push: true, pull: true };

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = temporaryDirectory("tempad-sync-forget-");
  databasePath = join(directory, "tempad.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function sync(database: Database, remote: FakeRemote, hostSlug = "host-a") {
  return runSyncEngine(database, remote, { hostSlug, batchSize: 500, ...both });
}

function triggerCount(database: Database): number {
  return (
    database
      .query(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${MIRROR_TRIGGER_NAMES.map(() => "?").join(", ")})`,
      )
      .get(...MIRROR_TRIGGER_NAMES) as { n: number }
  ).n;
}

function metaValue(database: Database, key: string): string {
  return (database.query("SELECT value FROM sync_meta WHERE key = ?").get(key) as { value: string })
    .value;
}

function count(database: Database, table: string): number {
  return (database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function metaKeys(database: Database): string[] {
  return (database.query("SELECT key FROM sync_meta ORDER BY key").all() as { key: string }[]).map(
    (row) => row.key,
  );
}

/** Stamps, hosts and dirty flags of every mirror row, to prove forget leaves them alone. */
function stampSnapshot(database: Database): unknown[] {
  return [
    "gh_repos",
    "gh_commits",
    "gh_pull_requests",
    "monday_items",
    "claude_sessions",
    "claude_messages",
    "events",
  ].map((table) =>
    database
      .query(
        `SELECT sync_host, sync_dirty${table === "events" ? ", uid" : ", sync_updated_at"} FROM ${table} ORDER BY rowid`,
      )
      .all(),
  );
}

/** Restamping and pushing on re-enable change these by design; everything else must come back identical. */
const SYNC_BOOKKEEPING = new Set(["sync_updated_at", "sync_dirty", "sync_host"]);

function withoutStamps(snapshot: Record<string, unknown[]>): unknown {
  return JSON.parse(
    JSON.stringify(snapshot, (key, value) => (SYNC_BOOKKEEPING.has(key) ? undefined : value)),
  );
}

function seed(database: Database): void {
  addRepository(database, "acme/web", '{"a":1}');
  addCommit(database, "c1", "acme/web", "first");
  addCommit(database, "c-gone", "acme/web", "to be deleted");
  addPullRequest(database, "acme/web", 7, "A pull request");
  addMondayItem(database, 42, "Ship it");
  addSession(database, "s-1", "host-a", ["m-1", "m-2"]);
}

/** A host that has synced for real: marker, triggers, tombstone, cursors, server identity. */
async function syncedHost(remote: FakeRemote): Promise<Database> {
  const database = openDatabase(databasePath, { hostSlug: "host-a" });
  await intent(database, ["hero", "init", "Saulo"]);
  await intent(database, ["party", "add", "acme", "Acme"]);
  seed(database);
  await sync(database, remote);
  database.query("DELETE FROM gh_commits WHERE sha = 'c-gone'").run();
  expect(count(database, "sync_tombstones")).toBe(1);
  // Push the tombstone too: a forget refuses while anything is unpushed.
  await sync(database, remote);
  return database;
}

describe("forgetSync", () => {
  test("drops the triggers, tombstones, cursors and remote-bound meta; leaves stamps and flags", async () => {
    const remote = new FakeRemote();
    const database = await syncedHost(remote);
    // A second host's pull put cursors and a server identity here too.
    expect(triggerCount(database)).toBe(18);
    expect(count(database, "sync_cursors")).toBeGreaterThan(0);
    expect(metaKeys(database)).toContain("server_id");
    const cursors = count(database, "sync_cursors");
    const stamps = stampSnapshot(database);
    const rows = sourceSnapshot(database);
    const serverId = metaValue(database, "server_id");
    // Markers the engine leaves behind mid-re-seed: both must go too.
    database.query("INSERT INTO sync_meta (key, value) VALUES ('reseed_pending', ?)").run(serverId);
    database.query("INSERT INTO sync_meta (key, value) VALUES ('pull_own_pending', 'ulid')").run();

    const summary = forgetSync(database);

    expect(summary).toEqual({
      triggersDropped: 18,
      tombstonesDeleted: 1,
      cursorsCleared: cursors,
      metaKeysDeleted: expect.arrayContaining([
        "mirror_sync_enabled",
        "server_id",
        "reseed_pending",
        "pull_own_pending",
        "push_probe_event",
        "push_probe_row",
      ]),
    });
    expect(triggerCount(database)).toBe(0);
    expect(isMirrorSyncEnabled(database)).toBe(false);
    expect(count(database, "sync_tombstones")).toBe(0);
    expect(count(database, "sync_cursors")).toBe(0);
    // Every remote-bound key is gone; only the id of the server left stays,
    // so a later run can refuse to rejoin it.
    expect(metaKeys(database)).toEqual([`forgotten_server_id:${serverId}`]);
    expect(stampSnapshot(database)).toEqual(stamps);
    expect(sourceSnapshot(database)).toEqual(rows);
    database.close();
  });

  test("a second forget has nothing to do", async () => {
    const database = await syncedHost(new FakeRemote());
    expect(forgetSync(database)).not.toBeNull();
    expect(forgetSync(database)).toBeNull();
    database.close();
  });

  test("a database that never synced has nothing to forget and is not touched", () => {
    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    seed(database);
    const stamps = stampSnapshot(database);
    expect(forgetSync(database)).toBeNull();
    expect(stampSnapshot(database)).toEqual(stamps);
    expect(triggerCount(database)).toBe(0);
    database.close();
  });

  test("leftover cursors alone count as something to forget", () => {
    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    database.query("INSERT INTO sync_cursors (stream, seq) VALUES ('rows', 3)").run();
    expect(forgetSync(database)?.cursorsCleared).toBe(1);
    expect(count(database, "sync_cursors")).toBe(0);
    database.close();
  });

  test("a server id with no marker still counts, and is remembered as forgotten", () => {
    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    database.query("INSERT INTO sync_meta (key, value) VALUES ('server_id', 'srv-1')").run();
    const summary = forgetSync(database);
    expect(summary).not.toBeNull();
    expect(summary?.metaKeysDeleted).toEqual(["server_id"]);
    expect(metaKeys(database)).toEqual(["forgotten_server_id:srv-1"]);
    database.close();
  });

  test("only reseed_pending set: that id is remembered, and a sync against it is refused", async () => {
    const remote = new FakeRemote();
    const other = openDatabase(join(directory, "other.db"), { hostSlug: "host-b" });
    await runSyncEngine(other, remote, { hostSlug: "host-b", batchSize: 500, ...both });
    other.close();
    const serverId = (
      remote.database.query("SELECT value FROM sync_meta WHERE key = 'server_id'").get() as {
        value: string;
      }
    ).value;

    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    database.query("INSERT INTO sync_meta (key, value) VALUES ('reseed_pending', ?)").run(serverId);
    expect(forgetSync(database)?.metaKeysDeleted).toEqual(["reseed_pending"]);
    expect(metaKeys(database)).toEqual([`forgotten_server_id:${serverId}`]);

    const error = await sync(database, remote).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(ForgottenServerError);
    expect(error.message).toContain(`tempad sync --rejoin ${serverId}`);
    database.close();
  });

  test("server_id and a different reseed_pending are both remembered", () => {
    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    database.query("INSERT INTO sync_meta (key, value) VALUES ('server_id', 'srv-old')").run();
    database.query("INSERT INTO sync_meta (key, value) VALUES ('reseed_pending', 'srv-new')").run();
    forgetSync(database);
    expect(metaKeys(database)).toEqual([
      "forgotten_server_id:srv-new",
      "forgotten_server_id:srv-old",
    ]);
    database.close();
  });

  test("forget A, use B, forget B: A and B are both still refused", async () => {
    const serverA = new FakeRemote();
    const database = await syncedHost(serverA);
    forgetSync(database);
    database.close();

    const serverB = new FakeRemote();
    const onB = openDatabase(databasePath, { hostSlug: "host-a" });
    await sync(onB, serverB);
    // Clean after the sync: nothing unpushed, so the second forget goes through.
    expect(forgetSync(onB)).not.toBeNull();
    expect(metaKeys(onB).filter((key) => key.startsWith("forgotten_server_id:"))).toHaveLength(2);

    expect(await sync(onB, serverA).catch((thrown) => thrown)).toBeInstanceOf(ForgottenServerError);
    expect(await sync(onB, serverB).catch((thrown) => thrown)).toBeInstanceOf(ForgottenServerError);
    onB.close();
  });

  test("a leftover after a forget forgets again without the unpushed-changes check", async () => {
    const database = await syncedHost(new FakeRemote());
    forgetSync(database);
    // Triggers are gone, so a new row is sync_dirty = 1 with nowhere to push it.
    addCommit(database, "c-after", "acme/web", "written after the forget");
    database.query("INSERT INTO sync_cursors (stream, seq) VALUES ('rows', 3)").run();
    expect(forgetSync(database)?.cursorsCleared).toBe(1);
    database.close();
  });

  test("rejoinServer takes one id out of the set and reports whether it was there", async () => {
    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    database.query("INSERT INTO sync_meta (key, value) VALUES ('server_id', 'srv-1')").run();
    forgetSync(database);
    expect(rejoinServer(database, "srv-2")).toBe(false);
    expect(metaKeys(database)).toEqual(["forgotten_server_id:srv-1"]);
    expect(rejoinServer(database, "srv-1")).toBe(true);
    expect(metaKeys(database)).toEqual([]);
    database.close();
  });

  test("a second forget keeps the remembered server id", async () => {
    const database = await syncedHost(new FakeRemote());
    const serverId = metaValue(database, "server_id");
    forgetSync(database);
    expect(forgetSync(database)).toBeNull();
    expect(metaKeys(database)).toEqual([`forgotten_server_id:${serverId}`]);
    database.close();
  });

  test("an unpushed delete refuses, changing nothing; --force drops it", async () => {
    const database = await syncedHost(new FakeRemote());
    database.query("DELETE FROM gh_commits WHERE sha = 'c1'").run();
    const keys = metaKeys(database);

    const error = (() => {
      try {
        forgetSync(database);
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(UnpushedChangesError);
    expect((error as Error).message).toStartWith("1 deletes / 0 changes never reached the server");
    expect(triggerCount(database)).toBe(18);
    expect(count(database, "sync_tombstones")).toBe(2);
    expect(metaKeys(database)).toEqual(keys);

    expect(forgetSync(database, undefined, true)).not.toBeNull();
    expect(triggerCount(database)).toBe(0);
    database.close();
  });

  test("an unpushed row change refuses, counting rows and events", async () => {
    const database = await syncedHost(new FakeRemote());
    addCommit(database, "c-new", "acme/web", "never pushed");
    await intent(database, ["party", "add", "other", "Other"]);
    const dirtyEvents = (
      database.query("SELECT COUNT(*) AS n FROM events WHERE sync_dirty = 1").get() as { n: number }
    ).n;
    expect(dirtyEvents).toBeGreaterThan(0);

    expect(() => forgetSync(database)).toThrow(
      `0 deletes / ${dirtyEvents + 1} changes never reached the server`,
    );
    expect(triggerCount(database)).toBe(18);
    expect(forgetSync(database, undefined, true)).not.toBeNull();
    database.close();
  });

  test("a reopen does not reinstall the triggers, and writes stamp and tombstone nothing", async () => {
    const database = await syncedHost(new FakeRemote());
    forgetSync(database);
    database.close();

    const reopened = openDatabase(databasePath, { hostSlug: "host-a" });
    expect(triggerCount(reopened)).toBe(0);
    expect(isMirrorSyncEnabled(reopened)).toBe(false);
    addCommit(reopened, "c-new", "acme/web", "after forget");
    expect(
      reopened
        .query("SELECT sync_updated_at, sync_dirty FROM gh_commits WHERE sha = 'c-new'")
        .get(),
    ).toEqual({ sync_updated_at: null, sync_dirty: 1 });
    reopened.query("DELETE FROM gh_commits WHERE sha = 'c1'").run();
    expect(count(reopened, "sync_tombstones")).toBe(0);
    reopened.close();
  });

  test("re-enabling pushes every existing row again to a fresh server, none lost", async () => {
    const first = new FakeRemote();
    const database = await syncedHost(first);
    forgetSync(database);
    database.close();

    const reopened = openDatabase(databasePath, { hostSlug: "host-a" });
    // Written while sync was off: no stamp, no tombstone.
    addCommit(reopened, "c-off", "acme/web", "written while sync was off");
    const rows = sourceSnapshot(reopened);

    const second = new FakeRemote();
    const summary = await sync(reopened, second);

    expect(summary.reseeded).toBe(true);
    expect(summary.pushed.events).toBe(count(reopened, "events"));
    const stored = second.database
      .query(
        "SELECT tbl, COUNT(*) AS n FROM sync_rows WHERE data IS NOT NULL GROUP BY tbl ORDER BY tbl",
      )
      .all();
    expect(stored).toEqual(
      [
        "claude_messages",
        "claude_sessions",
        "gh_commits",
        "gh_pull_requests",
        "gh_repos",
        "monday_items",
      ]
        .map((tbl) => ({
          tbl,
          n: (reopened.query(`SELECT COUNT(*) AS n FROM ${tbl}`).get() as { n: number }).n,
        }))
        .sort((a, b) => a.tbl.localeCompare(b.tbl)),
    );
    expect(second.database.query("SELECT COUNT(*) AS n FROM sync_events").get()).toEqual({
      n: count(reopened, "events"),
    });
    expect(
      second.database
        .query("SELECT 1 FROM sync_rows WHERE tbl = 'gh_commits' AND pk = '[\"c-off\"]'")
        .get(),
    ).not.toBeNull();
    // Nothing was lost or duplicated locally either.
    expect(withoutStamps(sourceSnapshot(reopened))).toEqual(withoutStamps(rows));
    expect(triggerCount(reopened)).toBe(18);
    reopened.close();
  });

  test("re-enabling against the server it left is refused, and touches nothing there", async () => {
    const remote = new FakeRemote();
    const database = await syncedHost(remote);
    forgetSync(database);
    database.close();
    const remoteBefore = {
      rows: remote.database
        .query(
          "SELECT tbl, pk, data, sync_host, sync_updated_at, seq FROM sync_rows ORDER BY tbl, pk",
        )
        .all(),
      events: remote.database.query("SELECT uid, seq FROM sync_events ORDER BY uid").all(),
      meta: remote.database.query("SELECT key, value FROM sync_meta ORDER BY key").all(),
    };

    const reopened = openDatabase(databasePath, { hostSlug: "host-a" });
    const error = await sync(reopened, remote).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(ForgottenServerError);
    expect(error.message).toContain("tempad sync --forget");
    expect(error.message).toContain("fresh server");
    expect({
      rows: remote.database
        .query(
          "SELECT tbl, pk, data, sync_host, sync_updated_at, seq FROM sync_rows ORDER BY tbl, pk",
        )
        .all(),
      events: remote.database.query("SELECT uid, seq FROM sync_events ORDER BY uid").all(),
      meta: remote.database.query("SELECT key, value FROM sync_meta ORDER BY key").all(),
    }).toEqual(remoteBefore);
    // The refusal left this database as forget left it: nothing re-enabled,
    // so a later forget is still a clean no-op.
    expect(triggerCount(reopened)).toBe(0);
    expect(isMirrorSyncEnabled(reopened)).toBe(false);
    expect(forgetSync(reopened)).toBeNull();
    reopened.close();
  });

  test("rejoining the remembered id is the explicit way back to the old server", async () => {
    const remote = new FakeRemote();
    const database = await syncedHost(remote);
    const serverId = metaValue(database, "server_id");
    forgetSync(database);
    expect(rejoinServer(database, serverId)).toBe(true);
    await expect(sync(database, remote)).resolves.toBeDefined();
    database.close();
  });

  test("a fresh server ends up with the same content, which a new host then pulls back", async () => {
    const database = await syncedHost(new FakeRemote());
    forgetSync(database);
    database.close();

    const reopened = openDatabase(databasePath, { hostSlug: "host-a" });
    addCommit(reopened, "c-off", "acme/web", "written while sync was off");
    const fresh = new FakeRemote();
    await sync(reopened, fresh);
    const rows = sourceSnapshot(reopened);
    reopened.close();

    const other = openDatabase(join(directory, "other.db"), { hostSlug: "host-b" });
    await runSyncEngine(other, fresh, { hostSlug: "host-b", batchSize: 500, ...both });
    expect(withoutStamps(sourceSnapshot(other))).toEqual(withoutStamps(rows));
    expect(
      other.query("SELECT subject FROM gh_commits WHERE sha IN ('c-off', 'c1') ORDER BY sha").all(),
    ).toEqual([{ subject: "written while sync was off" }, { subject: "first" }]);
    expect(other.query("SELECT 1 FROM gh_commits WHERE sha = 'c-gone'").get()).toBeNull();
    other.close();
  });

  test("pulled events not yet projected are projected before the markers go", async () => {
    const remote = new FakeRemote();
    const other = openDatabase(join(directory, "other.db"), { hostSlug: "host-b" });
    enableMirrorSync(other);
    await intent(other, ["hero", "init", "Saulo"]);
    await intent(other, ["party", "add", "acme", "Acme"]);
    await runSyncEngine(other, remote, { hostSlug: "host-b", batchSize: 500, ...both });

    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    await runSyncEngine(database, remote, {
      hostSlug: "host-a",
      batchSize: 500,
      ...both,
      // The pull inserted events; leave the projections stale on purpose.
      rebuildProjections: () => {},
    });
    expect(
      database.query("SELECT 1 FROM sync_meta WHERE key = 'rebuild_pending'").get(),
    ).not.toBeNull();
    let rebuilds = 0;

    forgetSync(database, (inside, options) => {
      rebuilds += 1;
      registerAllProjections();
      rebuildAll(inside, options);
    });

    expect(rebuilds).toBe(1);
    expect(count(database, "parties")).toBe(1);
    expect(metaKeys(database).map((key) => key.split(":")[0])).toEqual(["forgotten_server_id"]);
    database.close();
    other.close();
  });

  test("a rebuild that fails leaves everything exactly as it was", async () => {
    const remote = new FakeRemote();
    const other = openDatabase(join(directory, "other.db"), { hostSlug: "host-b" });
    enableMirrorSync(other);
    await intent(other, ["hero", "init", "Saulo"]);
    await runSyncEngine(other, remote, { hostSlug: "host-b", batchSize: 500, ...both });
    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    await runSyncEngine(database, remote, {
      hostSlug: "host-a",
      batchSize: 500,
      ...both,
      rebuildProjections: () => {},
    });
    const keys = metaKeys(database);

    expect(() =>
      forgetSync(database, () => {
        throw new Error("rebuild exploded");
      }),
    ).toThrow("rebuild exploded");

    expect(metaKeys(database)).toEqual(keys);
    expect(triggerCount(database)).toBe(18);
    database.close();
    other.close();
  });
});

describe("tempad sync --forget", () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = temporaryDirectory("tempad-sync-forget-cli-");
    home = join(root, "tempad");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(root, "home"), { recursive: true });
    mkdirSync(join(root, "cwd"), { recursive: true });
    writeFileSync(
      join(home, ".env"),
      ["CLAUDE_DIRS=/nowhere", "HOST_SLUG=host-a", "TZ=UTC", "SINCE=2020-01-01"].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", CLI, ...args],
      cwd: join(root, "cwd"),
      // No token, no network: --forget must not need either.
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: join(root, "home"),
        TEMPAD_HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  async function syncedHome(): Promise<void> {
    databasePath = join(home, "tempad.db");
    const database = await syncedHost(new FakeRemote());
    database.close();
  }

  test("refuses with exit 1 while [sync] is configured, and changes nothing", async () => {
    await syncedHome();
    writeFileSync(join(home, "tempad.toml"), '[sync]\nurl = "libsql://sync.example.ts.net"\n');
    const result = await cli(["sync", "--forget"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("remove the [sync] section first");
    expect(result.stdout).toBe("");
    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    expect(triggerCount(database)).toBe(18);
    expect(isMirrorSyncEnabled(database)).toBe(true);
    database.close();
  });

  test("forgets once [sync] is gone, prints the summary, and needs no token", async () => {
    await syncedHome();
    const result = await cli(["sync", "--forget"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^sync: forgot triggers=18 tombstones=1 cursors=\d+ meta=\d+\n$/);
    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    expect(triggerCount(database)).toBe(0);
    expect(isMirrorSyncEnabled(database)).toBe(false);
    database.close();
  });

  test("[sync] with enabled = false counts as removed", async () => {
    await syncedHome();
    writeFileSync(
      join(home, "tempad.toml"),
      '[sync]\nenabled = false\nurl = "libsql://sync.example.ts.net"\n',
    );
    const result = await cli(["sync", "--forget"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("sync: forgot");
  });

  test("nothing enabled: prints 'nothing to forget' and exits 0", async () => {
    const database = openDatabase(join(home, "tempad.db"), { hostSlug: "host-a" });
    database.close();
    const result = await cli(["sync", "--forget"]);
    expect(result).toEqual({ code: 0, stdout: "sync: nothing to forget\n", stderr: "" });
  });

  test("running it twice: the second is the no-op", async () => {
    await syncedHome();
    expect((await cli(["sync", "--forget"])).stdout).toContain("sync: forgot");
    expect((await cli(["sync", "--forget"])).stdout).toBe("sync: nothing to forget\n");
  });

  test("a home that was never set up exits 1 and creates nothing", async () => {
    rmSync(join(home, ".env"));
    const result = await cli(["sync", "--forget"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not set up yet");
  });

  for (const extra of [["--push"], ["--pull"], ["--full"], ["claude"]]) {
    test(`--forget with ${extra.join(" ")} is a usage error`, async () => {
      await syncedHome();
      const result = await cli(["sync", "--forget", ...extra]);
      expect(result.code).toBe(2);
      const database = openDatabase(databasePath, { hostSlug: "host-a" });
      expect(triggerCount(database)).toBe(18);
      database.close();
    });
  }

  test("unpushed changes: exit 1 naming the counts, nothing changed; --force forgets anyway", async () => {
    await syncedHome();
    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    database.query("DELETE FROM gh_commits WHERE sha = 'c1'").run();
    addCommit(database, "c-new", "acme/web", "never pushed");
    database.close();

    const refused = await cli(["sync", "--forget"]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(
      "sync: forget failed: 1 deletes / 1 changes never reached the server",
    );
    expect(refused.stderr).toContain("--force");
    const kept = openDatabase(databasePath, { hostSlug: "host-a" });
    expect(triggerCount(kept)).toBe(18);
    kept.close();

    const forced = await cli(["sync", "--forget", "--force"]);
    expect(forced.stderr).toBe("");
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain("sync: forgot triggers=18");
  });

  test("--rejoin removes one remembered id and prints it; an unknown id is a no-op", async () => {
    await syncedHome();
    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    const serverId = metaValue(database, "server_id");
    database.close();
    expect((await cli(["sync", "--forget"])).code).toBe(0);

    const unknown = await cli(["sync", "--rejoin", "nope"]);
    expect(unknown).toEqual({
      code: 0,
      stdout: "sync: server nope was not forgotten; nothing to do\n",
      stderr: "",
    });
    const result = await cli(["sync", "--rejoin", serverId]);
    expect(result).toEqual({
      code: 0,
      stdout: `sync: rejoin allowed for server ${serverId}\n`,
      stderr: "",
    });
    const kept = openDatabase(databasePath, { hostSlug: "host-a" });
    expect(metaKeys(kept)).toEqual([]);
    kept.close();
  });

  for (const extra of [["--forget"], ["--force"], ["--push"], ["--full"], ["claude"]]) {
    test(`--rejoin with ${extra.join(" ")} is a usage error`, async () => {
      expect((await cli(["sync", "--rejoin", "x", ...extra])).code).toBe(2);
    });
  }

  test("--force without --forget is a usage error", async () => {
    const result = await cli(["sync", "--force"]);
    expect(result.code).toBe(2);
  });

  test("a failure while forgetting exits 1 with 'sync: forget failed:'", async () => {
    await syncedHome();
    // Another connection holds the write lock; forget's IMMEDIATE transaction
    // gives up after the busy timeout.
    const blocker = openDatabase(databasePath, { hostSlug: "host-a" });
    blocker.exec("BEGIN IMMEDIATE");
    try {
      const result = await cli(["sync", "--forget"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^sync: forget failed: .*locked/m);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    const database = openDatabase(databasePath, { hostSlug: "host-a" });
    expect(triggerCount(database)).toBe(18);
    database.close();
  }, 30_000);

  test("--help lists --forget", async () => {
    const result = await cli(["--help"]);
    expect(result.stdout).toContain("--forget");
  });
});
