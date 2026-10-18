import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRY_USAGE } from "../../src/scry/cli";
import { formatReport } from "../../src/scry/format";
import type { ScryReport } from "../../src/scry/types";
import {
  ago,
  DAY,
  type Home,
  insertFailedJob,
  makeHealthyHome,
  makeHome,
  seedSession,
} from "./fixture";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const GUARD = join(import.meta.dir, "..", "sync", "libsql-guard.ts");

/** The words the ubiquitous-language spec bans from anything an operator reads. */
const BANNED =
  /\b(objectives?|purposes?|intents?|steps?|tasks?|goals?|activit(?:y|ies)|actions?|session quests?)\b/i;

const homes: Home[] = [];
const scratch: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    home.database.close();
    rmSync(home.directory, { recursive: true, force: true });
  }
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function tempad(
  args: string[],
  env: Record<string, string | undefined>,
  preload?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "tempad-scry-cwd-"));
  scratch.push(cwd);
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const name of ["HOST_SLUG", "TEMPAD_SYNC_TOKEN"]) if (!(name in env)) delete merged[name];
  const proc = Bun.spawn({
    cmd: [process.execPath, ...(preload ? ["--preload", preload] : []), CLI, ...args],
    cwd,
    env: merged,
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

describe("tempad scry (process)", () => {
  test("a healthy home exits 0 and --json parses", async () => {
    const home = makeHome();
    homes.push(home);
    const result = await tempad(["scry", "--json"], { TEMPAD_HOME: home.directory });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as ScryReport).ok).toBe(true);
  });

  test("a failed check exits 1; recommendations alone exit 0", async () => {
    const home = await makeHealthyHome();
    homes.push(home);
    seedSession(home.database, { id: "old", endedAt: ago(3 * DAY) });
    const withRecommendation = await tempad(["scry", "--json"], { TEMPAD_HOME: home.directory });
    expect(withRecommendation.code).toBe(0);
    expect(
      (JSON.parse(withRecommendation.stdout) as ScryReport).recommendations.map(
        (entry) => entry.id,
      ),
    ).toContain("backfill");

    home.database.query("DELETE FROM traces WHERE rowid = (SELECT MIN(rowid) FROM traces)").run();
    const broken = await tempad(["scry"], { TEMPAD_HOME: home.directory });
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain("Health: NOT healthy");
    expect(broken.stdout).toContain("tempad rebuild");
  });

  test("an unconfigured home exits 1 with the setup hint and creates nothing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "tempad-scry-empty-"));
    scratch.push(empty);
    const result = await tempad(["scry"], { TEMPAD_HOME: empty });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tempad is not set up yet");
    expect(readdirSync(empty)).toEqual([]);
  });

  test("usage errors exit 2", async () => {
    const home = makeHome();
    homes.push(home);
    for (const args of [
      ["scry", "--bogus"],
      ["scry", "--days", "0"],
    ]) {
      const result = await tempad(args, { TEMPAD_HOME: home.directory });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("usage: tempad scry");
    }
  });

  test("sync on with no HOST_SLUG exits 1 naming the variable", async () => {
    const home = makeHome({ hostSlug: null, toml: '[sync]\nurl = "libsql://example.invalid"\n' });
    homes.push(home);
    const result = await tempad(["scry"], { TEMPAD_HOME: home.directory });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HOST_SLUG");
  });
});

describe("offline guarantee", () => {
  test("scry never resolves @libsql/client, with sync off or on", async () => {
    for (const toml of [undefined, '[sync]\nurl = "libsql://example.invalid"\n']) {
      const home = makeHome({ toml });
      homes.push(home);
      const result = await tempad(
        ["scry"],
        { TEMPAD_HOME: home.directory, HOST_SLUG: "mac" },
        GUARD,
      );
      expect(result.stderr).not.toContain("LIBSQL_GUARD");
      expect(result.code).toBe(0);
    }
  });
});

describe("help", () => {
  test("`tempad --help` and `tempad scry --help` list scry", async () => {
    const home = makeHome();
    homes.push(home);
    for (const args of [["--help"], ["scry", "--help"]]) {
      const result = await tempad(args, { TEMPAD_HOME: home.directory });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("tempad scry [--json] [--days <n>] [--fast]");
    }
  });

  test("the scry usage text and a full report use none of the banned words", async () => {
    const help = await tempad(["--help"], {});
    const scryLine = help.stdout.split("\n").find((line) => line.includes("tempad scry")) ?? "";
    expect(scryLine).not.toBe("");
    expect(scryLine).not.toMatch(BANNED);
    expect(SCRY_USAGE).not.toMatch(BANNED);

    // A report that exercises every section: stale collector, failed jobs, pending windows, broken projection, sync on.
    const home = await makeHealthyHome({ toml: '[sync]\nurl = "libsql://example.invalid"\n' });
    homes.push(home);
    seedSession(home.database, { id: "old", endedAt: ago(3 * DAY) });
    insertFailedJob(
      home.database,
      "unknown claude session: 11111111-2222-3333-4444-555555555555",
      ago(DAY),
    );
    home.database.query("DELETE FROM sync_state WHERE source = 'github'").run();
    home.database.query("DELETE FROM traces WHERE rowid = (SELECT MIN(rowid) FROM traces)").run();
    const result = await tempad(["scry"], { TEMPAD_HOME: home.directory, HOST_SLUG: "mac" });
    expect(result.stdout).toContain("Recommendations");
    expect(result.stdout).not.toMatch(BANNED);

    const empty: ScryReport = {
      generatedAt: "2026-10-16T12:00:00.000Z",
      home: "/h",
      ok: true,
      windowDays: 15,
      checks: [],
      stats: null,
      recommendations: [],
      notes: [],
      durationMs: 0,
    };
    expect(formatReport(empty)).not.toMatch(BANNED);
  });
});
