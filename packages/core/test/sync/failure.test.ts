import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDatabase } from "../../src/db/database";
import type { SyncRemote } from "../../src/sync/engine";
import { runPushSync, SyncRunError } from "../../src/sync/run";
import { temporaryDirectory } from "./helpers";

// tempad-wqx: a push or pull that fails must exit non-zero and say so on
// stderr as `sync: push failed: <reason>`, without losing what the collectors
// already did.

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const GUARD = join(import.meta.dir, "libsql-guard.ts");
const TOKEN = "t-0123456789abcdef-secret";

let root: string;
let home: string;

beforeEach(() => {
  root = temporaryDirectory("tempad-sync-failure-");
  home = join(root, "tempad");
  const claudeDir = join(root, "claude");
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "cwd"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(claudeDir, "projects", "failure"), { recursive: true });
  writeFileSync(
    join(claudeDir, "projects", "failure", "session-1.jsonl"),
    `${JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: "sess-failure-1",
      timestamp: "2026-01-01T10:00:00.000Z",
      origin: { kind: "human" },
      message: { role: "user", content: "hello" },
    })}\n`,
  );
  writeFileSync(
    join(home, ".env"),
    [
      `CLAUDE_DIRS=${claudeDir}`,
      "HOST_SLUG=test-host",
      "TZ=UTC",
      "SINCE=2020-01-01",
      `TEMPAD_SYNC_TOKEN=${TOKEN}`,
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function useSyncUrl(url: string): void {
  writeFileSync(join(home, "tempad.toml"), `[sync]\nurl = "${url}"\n`);
}

async function cli(
  args: string[],
  runtimeArguments: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    // No `run`: `bun --preload x run file` prints bun's help and exits 0.
    cmd: [process.execPath, ...runtimeArguments, CLI, ...args],
    cwd: join(root, "cwd"),
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

/** A loopback server answering every request with one fixed status. */
function serverAnswering(status: number, body: string): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(body, { status, headers: { "content-type": "text/plain" } }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}

describe("tempad sync when the push fails", () => {
  test("the network module failing to load: exit 1, labelled line, collector results kept", async () => {
    useSyncUrl("http://127.0.0.1:9");
    // The guard replaces @libsql/client with a module that throws on load, the
    // same shape as the package being absent from node_modules.
    const result = await cli(["sync", "claude"], ["--preload", GUARD]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("claude: inserted=1");
    expect(result.stderr).toMatch(/^sync: push failed: .*LIBSQL_GUARD/m);
    expect(result.stderr.split("\n").filter((line) => line.startsWith("sync:"))).toHaveLength(1);
  });

  test("the collected rows are in the database after the failed push", async () => {
    useSyncUrl("http://127.0.0.1:9");
    expect((await cli(["sync", "claude"], ["--preload", GUARD])).code).toBe(1);
    const database = openDatabase(join(home, "tempad.db"), { hostSlug: "test-host" });
    const count = database.query("SELECT COUNT(*) AS n FROM claude_sessions").get() as {
      n: number;
    };
    database.close();
    expect(count.n).toBe(1);
  });

  test("sqld down (connection refused): exit 1 and a labelled line", async () => {
    useSyncUrl("http://127.0.0.1:9");
    const result = await cli(["sync", "claude"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("claude: inserted=1");
    expect(result.stderr).toMatch(/^sync: push failed: /m);
  });

  test("auth rejected (401): exit 1 and a labelled line, without the token", async () => {
    const server = serverAnswering(401, `Unauthorized for ${TOKEN}`);
    try {
      useSyncUrl(server.url);
      const result = await cli(["sync", "claude"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("claude: inserted=1");
      expect(result.stderr).toMatch(/^sync: push failed: /m);
      expect(result.stderr).not.toContain(TOKEN);
    } finally {
      server.stop();
    }
  });

  test("a server error (500): exit 1 and a labelled line", async () => {
    const server = serverAnswering(500, "boom");
    try {
      useSyncUrl(server.url);
      const result = await cli(["sync", "claude"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/^sync: push failed: /m);
    } finally {
      server.stop();
    }
  });

  test("--push alone fails the same way, with no collector output", async () => {
    useSyncUrl("http://127.0.0.1:9");
    const result = await cli(["sync", "--push"]);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("inserted=");
    expect(result.stderr).toMatch(/^sync: push failed: /m);
  });

  test("--pull alone says pull", async () => {
    useSyncUrl("http://127.0.0.1:9");
    const result = await cli(["sync", "--pull"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^sync: pull failed: /m);
  });
});

describe("runPushSync", () => {
  const request = (database: ReturnType<typeof openDatabase>, pull = true) => ({
    database,
    home,
    hostSlug: "test-host",
    syncToken: TOKEN,
    push: true,
    pull,
  });

  function failingRemote(message: string): { remote: SyncRemote; closed: () => boolean } {
    let closed = false;
    return {
      remote: {
        async query() {
          throw new Error(message);
        },
        async write() {
          throw new Error(message);
        },
        close() {
          closed = true;
        },
      },
      closed: () => closed,
    };
  }

  test("a remote failure becomes a SyncRunError with the labelled message and closes the remote", async () => {
    useSyncUrl("http://127.0.0.1:9");
    const database = openDatabase(join(home, "tempad.db"), { hostSlug: "test-host" });
    const { remote, closed } = failingRemote("connection reset");
    const error = await runPushSync(request(database), () => remote).catch((thrown) => thrown);
    database.close();
    expect(error).toBeInstanceOf(SyncRunError);
    expect(error.message).toBe("sync: push failed: connection reset");
    expect(closed()).toBe(true);
  });

  test("a failure opening the remote is labelled too", async () => {
    useSyncUrl("http://127.0.0.1:9");
    const database = openDatabase(join(home, "tempad.db"), { hostSlug: "test-host" });
    const error = await runPushSync(request(database), () => {
      throw new Error("Cannot find package '@libsql/client'");
    }).catch((thrown) => thrown);
    database.close();
    expect(error).toBeInstanceOf(SyncRunError);
    expect(error.message).toBe("sync: push failed: Cannot find package '@libsql/client'");
  });

  test("the token is redacted from the reason", async () => {
    useSyncUrl("http://127.0.0.1:9");
    const database = openDatabase(join(home, "tempad.db"), { hostSlug: "test-host" });
    const { remote } = failingRemote(`rejected ${TOKEN}`);
    const error = await runPushSync(request(database), () => remote).catch((thrown) => thrown);
    database.close();
    expect(error.message).toBe("sync: push failed: rejected <redacted>");
  });

  test("a pull-only request says pull", async () => {
    useSyncUrl("http://127.0.0.1:9");
    const database = openDatabase(join(home, "tempad.db"), { hostSlug: "test-host" });
    const { remote } = failingRemote("down");
    const error = await runPushSync({ ...request(database), push: false }, () => remote).catch(
      (thrown) => thrown,
    );
    database.close();
    expect(error.message).toBe("sync: pull failed: down");
  });
});
