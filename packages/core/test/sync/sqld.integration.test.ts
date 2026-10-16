/**
 * Push sync against a real sqld (`ghcr.io/tursodatabase/libsql-server`),
 * started here with a fresh Ed25519 key and removed with its volume in
 * `afterAll`. Skipped, with the reason printed, only when no `docker` CLI is
 * on PATH.
 */
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
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

const IMAGE = "ghcr.io/tursodatabase/libsql-server:latest";
const dockerPath = Bun.which("docker");
if (dockerPath === null) console.warn("sqld integration tests skipped: no `docker` CLI on PATH");

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function mintJwt(privateKey: KeyObject, claims: Record<string, unknown> = {}): string {
  const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

async function docker(args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ["docker", ...args], stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`docker ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
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
  const endpoint = await docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
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
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::8080",
    "-e",
    `SQLD_AUTH_JWT_KEY=${publicKey}`,
    IMAGE,
  ]);
  const server: Server = { name, url: "" };
  try {
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
  server.tunnel?.kill();
  await docker(["rm", "-f", "-v", server.name]);
}

describe.skipIf(dockerPath === null)("push sync against sqld", () => {
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
    server = await startServer(publicKey);
  }, 60_000);

  afterAll(async () => {
    await stopServer(server);
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
