import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierWindow } from "../../src/w5/classifier";
import {
  ClaudeCliClassifier,
  type CliSpawn,
  type CliSpawnResult,
  defaultSpawn,
} from "../../src/w5/classifier-cli";

const window: ClassifierWindow = {
  sessionId: "s1",
  title: "session",
  cwd: "/repo",
  gitBranch: "main",
  org: "acme",
  project: "widgets",
  messages: [
    { ts: "2026-09-04T15:00:00.000Z", role: "user", text: "fix bug" },
    { ts: "2026-09-04T15:05:00.000Z", role: "assistant", text: "done" },
  ],
  mode: "declared",
  activeQuests: [{ alias: "Q1", title: "Ship widgets", outcome: "shipped", plan: [] }],
  activeQuestAliases: { Q1: "01HREALQUESTIDONE000000000" },
  parentActiveQuests: [],
  parentActiveQuestAliases: {},
  openStintAliases: {},
  planAliases: {},
  openQuests: [],
  sessionOpenStints: [],
  recentStints: [],
  recentSideQuests: [],
  overlapMessages: [],
  previousSessionNote: null,
};

const good = {
  segments: [
    {
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:05:00.000Z",
      what: "fix bug",
      why: "ship widgets",
      belongs: true,
      guess: null,
      quest: "Q1",
      stint: "new: first segment of the session",
      isSwitch: false,
      trigger: null,
      confidence: 0.9,
      questions: [],
    },
  ],
  sessionNote: null,
};

function envelope(resultText: string): string {
  return JSON.stringify({ result: resultText, session_id: "cli-session", stop_reason: "end_turn" });
}

function makeSpawn(
  handler: (
    argv: string[],
    options: { cwd: string; stdin: string; timeoutMs: number },
  ) => CliSpawnResult,
): { spawn: CliSpawn; calls: { argv: string[]; stdin: string }[] } {
  const calls: { argv: string[]; stdin: string }[] = [];
  const spawn: CliSpawn = async (argv, options) => {
    calls.push({ argv, stdin: options.stdin });
    return handler(argv, options);
  };
  return { spawn, calls };
}

describe("ClaudeCliClassifier", () => {
  test("argv contains expected flags and model, stdin carries the prompt", async () => {
    const { spawn, calls } = makeSpawn(() => ({
      code: 0,
      stdout: envelope(JSON.stringify(good)),
      stderr: "",
    }));

    const classifier = new ClaudeCliClassifier({
      model: "claude-haiku-4-5-20251001",
      cwd: "/tempad-home",
      spawn,
    });

    await classifier.classify(window);

    expect(calls).toHaveLength(1);
    const call = calls[0] as { argv: string[]; stdin: string };
    expect(call.argv[0]).toBe("claude");
    expect(call.argv).toContain("-p");
    expect(call.argv).toContain("--safe-mode");
    expect(call.argv).toContain("--no-session-persistence");
    expect(call.argv).toContain("--output-format");
    expect(call.argv).toContain("json");
    expect(call.argv).toContain("--model");
    expect(call.argv).toContain("claude-haiku-4-5-20251001");
    expect(call.argv).toContain("--tools");
    expect(call.stdin.length).toBeGreaterThan(0);
    expect(call.stdin).toContain("fix bug");
  });

  test("respects custom command", async () => {
    const { spawn, calls } = makeSpawn(() => ({
      code: 0,
      stdout: envelope(JSON.stringify(good)),
      stderr: "",
    }));

    const classifier = new ClaudeCliClassifier({
      model: "m",
      cwd: "/tempad-home",
      command: "/usr/local/bin/claude",
      spawn,
    });

    await classifier.classify(window);
    expect(calls[0]?.argv[0]).toBe("/usr/local/bin/claude");
  });

  test("parses envelope result field", async () => {
    const { spawn } = makeSpawn(() => ({
      code: 0,
      stdout: envelope(JSON.stringify(good)),
      stderr: "",
    }));

    const classifier = new ClaudeCliClassifier({ model: "m", cwd: "/tempad-home", spawn });
    const result = await classifier.classify(window);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.what).toBe("fix bug");
  });

  test("tolerates fenced JSON in the result field", async () => {
    const { spawn } = makeSpawn(() => ({
      code: 0,
      stdout: envelope(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``),
      stderr: "",
    }));

    const classifier = new ClaudeCliClassifier({ model: "m", cwd: "/tempad-home", spawn });
    const result = await classifier.classify(window);
    expect(result.segments).toHaveLength(1);
  });

  test("retries once on invalid JSON then throws", async () => {
    let callCount = 0;
    const { spawn } = makeSpawn(() => {
      callCount += 1;
      return { code: 0, stdout: envelope("not json"), stderr: "" };
    });

    const classifier = new ClaudeCliClassifier({ model: "m", cwd: "/tempad-home", spawn });
    await expect(classifier.classify(window)).rejects.toThrow();
    expect(callCount).toBe(2);
  });

  test("non-zero exit throws with stderr excerpt", async () => {
    const { spawn } = makeSpawn(() => ({
      code: 1,
      stdout: "",
      stderr: "boom: something went wrong",
    }));

    const classifier = new ClaudeCliClassifier({ model: "m", cwd: "/tempad-home", spawn });
    await expect(classifier.classify(window)).rejects.toThrow(/boom: something went wrong/);
  });

  test("passes configured timeoutMs through to spawn", async () => {
    let seenTimeoutMs: number | undefined;
    const spawn: CliSpawn = async (_argv, options) => {
      seenTimeoutMs = options.timeoutMs;
      return { code: 0, stdout: envelope(JSON.stringify(good)), stderr: "" };
    };

    const classifier = new ClaudeCliClassifier({
      model: "m",
      cwd: "/tempad-home",
      spawn,
      timeoutMs: 60_000,
    });

    await classifier.classify(window);
    expect(seenTimeoutMs).toBe(60_000);
  });

  test("timeout throws", async () => {
    const spawn: CliSpawn = async () => {
      throw new Error("claude cli timed out after 1ms");
    };

    const classifier = new ClaudeCliClassifier({
      model: "m",
      cwd: "/tempad-home",
      spawn,
      timeoutMs: 1,
    });

    await expect(classifier.classify(window)).rejects.toThrow(/timed out/);
  });

  test("defaultSpawn does not hang when the child ignores SIGTERM", async () => {
    // Traps SIGTERM and never exits on its own, simulating a child (or a grandchild
    // holding the pipes open) that survives the first kill signal.
    const start = Date.now();
    await expect(
      defaultSpawn(["sh", "-c", "trap '' TERM; while true; do sleep 0.05; done"], {
        cwd: "/tmp",
        stdin: "",
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out after 50ms/);
    // Must reject promptly on the timeout, not after waiting on the hung pipes/exit.
    expect(Date.now() - start).toBeLessThan(2_000);

    // Wait past the SIGKILL grace period so the harder kill actually lands and this
    // test doesn't leave an orphaned process running after the suite exits.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
  }, 10_000);
});

describe("the claude child process environment", () => {
  const SECRETS = {
    TEMPAD_SYNC_TOKEN: "sync-secret-jwt",
    MONDAY_API_TOKEN: "monday-secret",
    GH_TOKEN: "github-secret",
  };
  const PASSING = { ANTHROPIC_API_KEY: "sk-ant-passes-through", TEMPAD_TEST_OTHER: "other-value" };
  const names = [...Object.keys(SECRETS), ...Object.keys(PASSING)];
  let dir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tempad-classifier-env-"));
    saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, SECRETS, PASSING);
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("ClaudeCliClassifier's real spawn hands `claude` no tempad secret, and the rest of the environment", async () => {
    const dump = join(dir, "env.dump");
    const fakeClaude = join(dir, "claude");
    const reply = envelope(JSON.stringify(good));
    writeFileSync(
      fakeClaude,
      `#!/bin/sh\nenv > "${dump}"\ncat > /dev/null\nprintf '%s' '${reply.replaceAll("'", "'\\''")}'\n`,
    );
    chmodSync(fakeClaude, 0o755);

    const classifier = new ClaudeCliClassifier({ model: "m", command: fakeClaude, cwd: dir });
    const result = await classifier.classify(window);
    expect(result.segments).toHaveLength(1);

    // Compare whole lines by name (a bare substring would match G2I_GH_TOKEN), and assert on
    // booleans so a failure never prints the machine's real environment.
    const lines = readFileSync(dump, "utf8").split("\n");
    const has = (line: string): boolean => lines.includes(line);
    const named = (name: string): boolean => lines.some((line) => line.startsWith(`${name}=`));
    for (const [name, value] of Object.entries(SECRETS)) {
      expect({ name, present: named(name) }).toEqual({ name, present: false });
      expect({ name, leaked: lines.some((line) => line.includes(value)) }).toEqual({
        name,
        leaked: false,
      });
    }
    for (const [name, value] of Object.entries(PASSING)) {
      expect({ name, passed: has(`${name}=${value}`) }).toEqual({ name, passed: true });
    }
    expect(named("PATH")).toBe(true);
  });
});
