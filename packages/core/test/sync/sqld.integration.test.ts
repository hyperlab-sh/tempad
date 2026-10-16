/**
 * Push sync against a real sqld (`ghcr.io/tursodatabase/libsql-server`,
 * pinned by digest), started here with a fresh Ed25519 key and removed with
 * its volume in `afterAll`. Skipped, with the reason printed, when there is
 * no `docker` CLI or `docker info` cannot reach a daemon; never silently.
 *
 * Containers are named `tempad-sqld-test-<hex>`, labelled `tempad-test=sqld`
 * and run with `--rm`. A name is recorded before `docker run`, so `afterAll`
 * and a `process.on("exit")` hook remove it even when `beforeAll` timed out
 * mid-start; `beforeAll` first sweeps labelled containers a killed run left.
 */
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { SyncConfig } from "../../src/sync/config";
import { runSyncEngine, type SyncRemote } from "../../src/sync/engine";
import { openRemote } from "../../src/sync/remote";
import {
  addCommit,
  addMondayItem,
  addPullRequest,
  addRepository,
  addSession,
  failingOnWrite,
  intent,
  openHost,
  projectionSnapshot,
  sourceSnapshot,
  temporaryDirectory,
} from "./helpers";

// `ghcr.io/tursodatabase/libsql-server:latest` as pulled on 2026-10-16 (image
// created 2026-08-23). docs/deploy/sqld-coolify.md's tested claims name it.
const IMAGE =
  "ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67";
const LABEL = "tempad-test=sqld";
const OWNER_LABEL = "tempad-test-owner";
/** `<hostname>:<pid>:<start ms>` of this test process. */
const OWNER = `${hostname()}:${process.pid}:${Date.now()}`;
const STALE_AFTER_MS = 30 * 60_000;
const PULL_TIMEOUT_MS = 300_000;
const DOCKER_TIMEOUT_MS = 60_000;

/** Why the suite cannot run here, or null when a daemon answers. */
function dockerSkipReason(): string | null {
  if (Bun.which("docker") === null) return "no `docker` CLI on PATH";
  const probe = Bun.spawnSync({
    cmd: ["docker", "info", "--format", "{{.ServerVersion}}"],
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  if (probe.exitCode === 0) return null;
  const detail = probe.stderr.toString().trim().split("\n")[0];
  return `docker daemon unreachable (docker info: ${detail || (probe.exitCode === null ? "timed out" : `exit ${probe.exitCode}`)})`;
}

const skipReason = dockerSkipReason();
if (skipReason !== null) console.warn(`sqld integration tests skipped: ${skipReason}`);

/** Every container name this process may have started, removed on exit. */
const started = new Set<string>();
const tunnels = new Set<ReturnType<typeof Bun.spawn>>();
process.on("exit", () => {
  for (const tunnel of tunnels) tunnel.kill();
  if (started.size > 0) {
    Bun.spawnSync({
      cmd: ["docker", "rm", "-f", "-v", ...started],
      stdout: "ignore",
      stderr: "ignore",
      timeout: 30_000,
    });
  }
});

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function mintJwt(privateKey: KeyObject, claims: Record<string, unknown> = {}): string {
  const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

async function docker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<string> {
  const proc = Bun.spawn({ cmd: ["docker", ...args], stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(
        `docker ${args[0]} failed (exit ${code}): ${stderr.trim() || "killed after timeout"}`,
      );
    }
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function removeContainers(names: string[]): Promise<void> {
  if (names.length === 0) return;
  // `docker rm -f` of a name already gone (`--rm`) fails; that is fine.
  await docker(["rm", "-f", "-v", ...names]).catch(() => {});
  for (const name of names) started.delete(name);
}

/** Removes labelled containers a killed earlier run left behind. */
function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to someone else, so it is alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a leftover test container may be removed. Another run of this
 * suite (a parallel worktree, a second agent) may be using its own right
 * now, so only two cases qualify: its owner ran on this machine and that
 * process is gone, or it is older than STALE_AFTER_MS. A container whose
 * owner runs on this machine and is alive is never touched, however old;
 * one with no parseable owner (an older version of this suite) or another
 * machine's owner goes by age alone.
 */
function sweepable(owner: string, createdAt: string, now: number): boolean {
  const match = /^(.+):(\d+):(\d+)$/.exec(owner);
  if (match !== null && match[1] === hostname()) {
    const pid = Number(match[2]);
    if (pid === process.pid || ownerAlive(pid)) return false;
    return true;
  }
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && now - created > STALE_AFTER_MS;
}

async function sweepStaleContainers(): Promise<void> {
  const ids = await docker(["ps", "-aq", "--filter", `label=${LABEL}`]);
  if (ids === "") return;
  const lines = await docker([
    "inspect",
    "--format",
    `{{.Name}}\t{{index .Config.Labels "${OWNER_LABEL}"}}\t{{.Created}}`,
    ...ids.split("\n"),
  ]);
  const now = Date.now();
  const stale = lines
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([, owner = "", created = ""]) => sweepable(owner, created, now))
    .map(([name = ""]) => name.replace(/^\//, ""))
    .filter((name) => name !== "");
  if (stale.length > 0) await removeContainers(stale);
}

async function ensureImage(): Promise<void> {
  const present = await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]).then(
    () => true,
    () => false,
  );
  if (!present) await docker(["pull", IMAGE], PULL_TIMEOUT_MS);
}

interface Server {
  name: string;
  url: string;
  tunnel?: ReturnType<typeof Bun.spawn>;
}

/**
 * The docker CLI may drive a remote daemon (an `ssh://` context). The
 * container's port is published on that host's loopback only, so reach it
 * through an SSH tunnel to a local loopback port rather than exposing it.
 */
async function dockerSshHost(): Promise<string | null> {
  // DOCKER_HOST overrides the context, exactly as the docker CLI resolves it.
  const endpoint =
    process.env.DOCKER_HOST ||
    (await docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]));
  return endpoint.startsWith("ssh://") ? endpoint.slice("ssh://".length) : null;
}

function freeLocalPort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function startServer(publicKey: string): Promise<Server> {
  const name = `tempad-sqld-test-${randomBytes(4).toString("hex")}`;
  // Recorded before `docker run`: a timeout or abort past this point still
  // has a name for afterAll and the exit hook to remove.
  started.add(name);
  const server: Server = { name, url: "" };
  try {
    await docker([
      "run",
      "-d",
      "--rm",
      "--label",
      LABEL,
      "--label",
      `${OWNER_LABEL}=${OWNER}`,
      "--name",
      name,
      "-p",
      "127.0.0.1::8080",
      "-e",
      `SQLD_AUTH_JWT_KEY=${publicKey}`,
      IMAGE,
    ]);
    const mapped = (await docker(["port", name, "8080/tcp"])).split("\n")[0] ?? "";
    const sshHost = await dockerSshHost();
    if (sshHost === null) {
      server.url = `http://${mapped}`;
    } else {
      const remotePort = mapped.split(":").at(-1);
      const localPort = freeLocalPort();
      server.tunnel = Bun.spawn({
        cmd: [
          "ssh",
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
          sshHost,
        ],
        stdout: "ignore",
        stderr: "ignore",
      });
      tunnels.add(server.tunnel);
      server.url = `http://127.0.0.1:${localPort}`;
    }
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(`${server.url}/health`);
        if (response.ok) return server;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`sqld ${name} not ready at ${server.url}`);
      await Bun.sleep(200);
    }
  } catch (error) {
    await stopServer(server);
    throw error;
  }
}

async function stopServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  if (server.tunnel !== undefined) {
    server.tunnel.kill();
    tunnels.delete(server.tunnel);
  }
  await removeContainers([server.name]);
}

describe("leftover container sweep", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const old = "2026-10-16T11:00:00Z";
  const fresh = "2026-10-16T11:55:00Z";
  const deadPid = 2 ** 22 + 12_345;

  test("never sweeps a container whose owner on this machine is alive, however old", () => {
    expect(sweepable(`${hostname()}:${process.pid}:1`, old, now)).toBe(false);
    expect(sweepable(`${hostname()}:1:1`, old, now)).toBe(false);
  });

  test("sweeps a container whose owner on this machine is gone, however young", () => {
    expect(ownerAlive(deadPid)).toBe(false);
    expect(sweepable(`${hostname()}:${deadPid}:1`, fresh, now)).toBe(true);
  });

  test("another machine's or an unowned container goes by age", () => {
    expect(sweepable(`elsewhere:${process.pid}:1`, fresh, now)).toBe(false);
    expect(sweepable(`elsewhere:${process.pid}:1`, old, now)).toBe(true);
    expect(sweepable("", fresh, now)).toBe(false);
    expect(sweepable("", old, now)).toBe(true);
    expect(sweepable("<no value>", "not a date", now)).toBe(false);
  });
});

describe.skipIf(skipReason !== null)("push sync against sqld", () => {
  let server: Server | undefined;
  let token = "";
  let publicKey = "";
  let privateKey: KeyObject;
  let directory: string;

  const config = (overrides: Partial<SyncConfig> = {}): SyncConfig => ({
    url: (server as Server).url,
    token,
    batchSize: 500,
    ...overrides,
  });

  async function sync(
    database: Database,
    hostSlug: string,
    remote: SyncRemote = openRemote(config()),
    batchSize = 500,
  ) {
    try {
      return await runSyncEngine(database, remote, { hostSlug, batchSize, push: true, pull: true });
    } finally {
      remote.close();
    }
  }

  async function remoteClock(): Promise<number> {
    const remote = openRemote(config());
    try {
      return Number((await remote.query("SELECT seq FROM sync_clock WHERE id = 1"))[0]?.seq);
    } finally {
      remote.close();
    }
  }

  async function resetRemote(): Promise<void> {
    const remote = openRemote(config());
    try {
      await remote.write(
        ["sync_meta", "sync_clock", "sync_rows", "sync_events"].map((table) => ({
          sql: `DROP TABLE IF EXISTS ${table}`,
          args: [],
        })),
      );
    } finally {
      remote.close();
    }
  }

  beforeAll(async () => {
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    // sqld takes the raw 32-byte public key, base64url without padding.
    publicKey = pair.publicKey.export({ format: "jwk" }).x as string;
    token = mintJwt(privateKey);
    directory = temporaryDirectory("tempad-sqld-test-");
    await sweepStaleContainers();
    await ensureImage();
    server = await startServer(publicKey);
  }, PULL_TIMEOUT_MS + 120_000);

  afterAll(async () => {
    await stopServer(server);
    // Anything started but never handed back (beforeAll timed out mid-start).
    for (const tunnel of tunnels) tunnel.kill();
    tunnels.clear();
    await removeContainers([...started]);
    if (directory) rmSync(directory, { recursive: true, force: true });
  }, 30_000);

  test("two hosts converge, a second sync is a no-op, a lost server is re-seeded", async () => {
    await resetRemote();
    const hostA = openHost(directory, "conv-a");
    const hostB = openHost(directory, "conv-b");
    try {
      await intent(hostA, ["hero", "init", "Saulo"]);
      await intent(hostA, ["party", "add", "acme", "Acme"]);
      addRepository(hostA, "acme/web", '{"a":1}');
      addCommit(hostA, "c1", "acme/web", "first");
      addCommit(hostA, "c-gone", "acme/web", "deleted later");
      addPullRequest(hostA, "acme/web", 7, "PR");
      addSession(hostA, "s-a", "conv-a", ["m-a1", "m-a2"]);

      await intent(hostB, ["hero", "init", "Saulo on b"]);
      await intent(hostB, ["party", "add", "acme", "Acme"]);
      addRepository(hostB, "acme/web", '{"b":1}');
      addRepository(hostB, "acme/api");
      addCommit(hostB, "c2", "acme/api", "second");
      addMondayItem(hostB, 42, "Ship it");
      addSession(hostB, "s-b", "conv-b", ["m-b1"]);

      await sync(hostA, "conv-a");
      hostA.query("DELETE FROM gh_commits WHERE sha = 'c-gone'").run();
      await sync(hostB, "conv-b");
      await sync(hostA, "conv-a");
      await sync(hostB, "conv-b");

      expect(sourceSnapshot(hostA)).toEqual(sourceSnapshot(hostB));
      expect(projectionSnapshot(hostA)).toEqual(projectionSnapshot(hostB));
      expect(hostA.query("SELECT COUNT(*) AS n FROM heroes").get()).toEqual({ n: 1 });
      expect(hostB.query("SELECT sha FROM gh_commits WHERE sha = 'c-gone'").get()).toBeNull();

      const clock = await remoteClock();
      for (const [database, slug] of [
        [hostA, "conv-a"],
        [hostB, "conv-b"],
      ] as const) {
        const summary = await sync(database, slug);
        expect(summary.pushed).toEqual({ events: 0, rows: 0, tombstones: 0 });
        expect(summary.pulled).toEqual({ events: 0, rows: 0, tombstones: 0 });
      }
      expect(await remoteClock()).toBe(clock);

      // The server loses everything: each host re-seeds it on its next run.
      await resetRemote();
      const reseedA = await sync(hostA, "conv-a");
      expect(reseedA.reseeded).toBe(true);
      expect(reseedA.pushed.events).toBeGreaterThan(0);
      const reseedB = await sync(hostB, "conv-b");
      expect(reseedB.reseeded).toBe(true);

      const third = openHost(directory, "conv-c");
      try {
        await sync(third, "conv-c");
        expect(sourceSnapshot(third).events).toEqual(sourceSnapshot(hostA).events);
        expect(sourceSnapshot(third).gh_commits).toEqual(sourceSnapshot(hostA).gh_commits);
        expect(projectionSnapshot(third)).toEqual(projectionSnapshot(hostA));
      } finally {
        third.close();
      }
    } finally {
      hostA.close();
      hostB.close();
    }
  }, 30_000);

  test("a parent updated after its child still applies when pulled one page at a time", async () => {
    await resetRemote();
    const hostA = openHost(directory, "fk-a");
    const hostB = openHost(directory, "fk-b");
    try {
      addRepository(hostA, "acme/web");
      addCommit(hostA, "c1", "acme/web", "child");
      addSession(hostA, "s1", "fk-a", ["m1"]);
      await sync(hostA, "fk-a", openRemote(config()), 1);
      hostA.query("UPDATE gh_repos SET meta = '{\"later\":true}'").run();
      hostA.query("UPDATE claude_sessions SET title = 'later'").run();
      await sync(hostA, "fk-a", openRemote(config()), 1);

      const remote = openRemote(config());
      try {
        const summary = await runSyncEngine(hostB, remote, {
          hostSlug: "fk-b",
          batchSize: 1,
          pageSize: 1,
          push: true,
          pull: true,
        });
        expect(summary.pulled.rows).toBe(4);
      } finally {
        remote.close();
      }
      expect(sourceSnapshot(hostB)).toEqual(sourceSnapshot(hostA));
    } finally {
      hostA.close();
      hostB.close();
    }
  }, 30_000);

  test("a push that fails after its first batch resumes and converges", async () => {
    await resetRemote();
    const hostA = openHost(directory, "partial-a");
    const hostB = openHost(directory, "partial-b");
    try {
      await sync(hostA, "partial-a"); // first contact
      addRepository(hostA, "acme/web");
      for (let index = 0; index < 5; index += 1)
        addCommit(hostA, `p${index}`, "acme/web", `c${index}`);
      // schema write, gh_repos batch, first commit batch, then fail.
      const flaky = failingOnWrite(openRemote(config()), 4);
      await expect(sync(hostA, "partial-a", flaky, 2)).rejects.toThrow("injected remote failure");
      expect(
        hostA.query("SELECT COUNT(*) AS n FROM gh_commits WHERE sync_dirty = 1").get(),
      ).toEqual({ n: 3 });

      const resumed = await sync(hostA, "partial-a", openRemote(config()), 2);
      expect(resumed.pushed.rows).toBe(3);
      await sync(hostB, "partial-b");
      expect(sourceSnapshot(hostB)).toEqual(sourceSnapshot(hostA));
    } finally {
      hostA.close();
      hostB.close();
    }
  }, 30_000);

  test("the schema gate refuses an older host", async () => {
    await resetRemote();
    const host = openHost(directory, "gate-a");
    try {
      await sync(host, "gate-a");
      const remote = openRemote(config());
      await remote.write([
        { sql: "UPDATE sync_meta SET value = '9999' WHERE key = 'schema_version'", args: [] },
      ]);
      remote.close();
      await expect(sync(host, "gate-a")).rejects.toThrow(
        /^remote holds data from tempad schema 9999; upgrade tempad on this host \(schema \d+\)$/,
      );
    } finally {
      host.close();
    }
  }, 30_000);

  test("the CLI prints the summary, and a bad token exits 1 without leaking it", async () => {
    await resetRemote();
    const home = join(directory, "cli-home");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "tempad.toml"), `[sync]\nurl = "${(server as Server).url}"\n`);
    writeFileSync(
      join(home, ".env"),
      [
        "MONDAY_API_TOKEN=token",
        "MONDAY_USER=1",
        "GH_USER=octocat",
        "GH_ORGS=acme",
        "GH_INCLUDE_PERSONAL=false",
        "GIT_AUTHOR_EMAILS=octocat@example.com",
        `CLAUDE_DIRS=${join(home, "claude")}`,
        "HOST_SLUG=cli-host",
        "TZ=UTC",
        "SINCE=2020-01-01",
      ].join("\n"),
    );
    const run = async (args: string[], syncToken: string) => {
      const proc = Bun.spawn({
        cmd: ["bun", join(import.meta.dir, "..", "..", "src", "cli.ts"), ...args],
        env: { ...process.env, TEMPAD_HOME: home, TEMPAD_SYNC_TOKEN: syncToken },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };

    const ok = await run(["sync", "--push", "--pull"], mintJwt(privateKey, { sub: "cli-host" }));
    expect(ok.stderr).toBe("");
    expect(ok.code).toBe(0);
    expect(ok.stdout.trim()).toMatch(
      /^sync: pushed events=\d+ rows=\d+ tombstones=\d+ pulled events=\d+ rows=\d+ tombstones=\d+ rebuilt=(yes|no)$/,
    );

    const other = generateKeyPairSync("ed25519").privateKey;
    const badToken = mintJwt(other, { sub: "intruder" });
    const bad = await run(["sync", "--push"], badToken);
    expect(bad.code).toBe(1);
    expect(bad.stdout).not.toContain("sync: pushed");
    expect(bad.stderr.trim()).toBe("SERVER_ERROR: Server returned HTTP status 401");
    expect(bad.stderr).not.toContain(badToken);
    expect(bad.stderr).not.toContain(badToken.split(".")[2] as string);
    expect(bad.stderr.toLowerCase()).not.toContain("authorization");
  }, 30_000);
});
