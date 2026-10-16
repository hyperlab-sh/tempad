import { describe, expect, test } from "bun:test";
import { childEnvironment } from "../src/config/child-env.ts";
import { ENV_VARS } from "../src/config/env.ts";
import { spawnWithTimeout } from "../src/setup/index.ts";

const environment: NodeJS.ProcessEnv = {
  TEMPAD_SYNC_TOKEN: "sync-secret-jwt",
  MONDAY_API_TOKEN: "monday-secret",
  GH_TOKEN: "github-secret",
  MONDAY_USER: "42",
  ANTHROPIC_API_KEY: "sk-ant",
  PATH: "/usr/bin",
  UNSET: undefined,
};

describe("childEnvironment", () => {
  test("drops every secret ENV_VARS lists, keeps the rest, and omits undefined values", () => {
    const secrets = ENV_VARS.filter((variable) => variable.secret).map((variable) => variable.name);
    expect(secrets).toContain("TEMPAD_SYNC_TOKEN");
    const child = childEnvironment([], environment);
    for (const name of secrets) expect(child).not.toHaveProperty(name);
    expect(child).toEqual({ MONDAY_USER: "42", ANTHROPIC_API_KEY: "sk-ant", PATH: "/usr/bin" });
  });

  test("a named secret is kept; the others still go", () => {
    expect(childEnvironment(["GH_TOKEN"], environment)).toEqual({
      GH_TOKEN: "github-secret",
      MONDAY_USER: "42",
      ANTHROPIC_API_KEY: "sk-ant",
      PATH: "/usr/bin",
    });
  });

  test("the sync token cannot be kept by accident of the default", () => {
    expect(childEnvironment(undefined, environment).TEMPAD_SYNC_TOKEN).toBeUndefined();
  });

  test("setup's real spawn: gh keeps GH_TOKEN, nothing else secret", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, environment);
    try {
      const result = await spawnWithTimeout(["env"], { timeoutMs: 5_000 });
      // Booleans, so a failure never prints the machine's real environment.
      const lines = result.stdout.split("\n");
      expect(lines.includes("GH_TOKEN=github-secret")).toBe(true);
      expect(lines.some((line) => line.startsWith("TEMPAD_SYNC_TOKEN="))).toBe(false);
      expect(lines.some((line) => line.startsWith("MONDAY_API_TOKEN="))).toBe(false);
    } finally {
      for (const name of Object.keys(environment)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });
});
