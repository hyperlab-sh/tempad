import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { ENV_VARS } from "../src/config/env.ts";
import { PINNED_VARIABLES, USER_SCOPED_VARIABLES } from "./isolation.ts";

describe("test environment isolation", () => {
  // Not asserted: `os.homedir()`. Bun reads HOME once at startup, so it keeps returning the real
  // home in-process. Code that writes under the user's home must read `process.env.HOME` (as
  // `userClaudeDirectory` does), never `homedir()`.
  test("HOME is a throwaway directory under the temp dir", () => {
    expect(process.env.HOME).toStartWith(`${tmpdir()}/tempad-test-home-`);
  });

  test("no user-scoped variable survives into the test process", () => {
    const leaked = USER_SCOPED_VARIABLES.filter((name) => process.env[name] !== undefined);
    expect(leaked).toEqual([]);
  });

  test("git ignores the developer's global and system config", async () => {
    for (const [name, value] of Object.entries(PINNED_VARIABLES)) {
      expect(process.env[name]).toBe(value);
    }
    const proc = Bun.spawn(["git", "config", "--global", "--list"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect((await new Response(proc.stdout).text()).trim()).toBe("");
    await proc.exited;
  });

  test("the list covers every variable in ENV_VARS plus the Claude and tempad locations", () => {
    for (const variable of ENV_VARS) expect(USER_SCOPED_VARIABLES).toContain(variable.name);
    for (const name of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_PROJECT_DIR",
      "TEMPAD_BIN",
      "TEMPAD_HOME",
      "TEMPAD_HOOK_SOURCE",
    ]) {
      expect(USER_SCOPED_VARIABLES).toContain(name);
    }
  });
});
