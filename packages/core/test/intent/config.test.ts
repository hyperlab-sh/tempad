import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConfigWarningKind,
  defaultIntentConfig,
  loadIntentConfig,
} from "../../src/intent/config";

function writeToml(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "tempad-intent-")), "tempad.toml");
  writeFileSync(path, content);
  return path;
}

describe("intent config", () => {
  test("parses hero, parties, clients and w5 with defaults", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[hero]
name = "Saulo"
[[parties]]
slug = "mosaic"
name = "Mosaic"
joined = "2025-07-01"
[[clients]]
slug = "liuna"
name = "LiUNA"
[w5]
throttle_minutes = 5
`,
    );
    const config = loadIntentConfig(path);
    expect(config.hero?.name).toBe("Saulo");
    expect(config.parties[0]?.slug).toBe("mosaic");
    expect(config.clients[0]?.name).toBe("LiUNA");
    expect(config.w5.throttleMinutes).toBe(5);
    expect(config.w5.watchTurns).toBe(3);
    expect(config.w5.backfillDays).toBe(15);
    expect(config.w5.backend).toBe("claude-cli");
    expect(config.w5.claudeCommand).toBe("claude");
    expect(config.w5.timeoutSeconds).toBe(180);
    expect(config.w5.stintIdleMinutes).toBe(45);
    expect(config.w5.memoryHours).toBe(8);
    expect(config.w5.memoryStints).toBe(10);
    expect(config.w5.overlapMessages).toBe(3);
  });

  test("accepts the pre-rename [w5] key names and warns naming the new key", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    // Exactly the shape of an operator's config written before 2026-09-07.
    writeFileSync(
      path,
      `
[w5]
ask_min_activity_minutes = 20
activity_idle_minutes = 30
memory_activities = 5
`,
    );
    const warnings: string[] = [];
    const config = loadIntentConfig(path, (message) => warnings.push(message));

    expect(config.w5.askMinStintMinutes).toBe(20);
    expect(config.w5.stintIdleMinutes).toBe(30);
    expect(config.w5.memoryStints).toBe(5);

    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("ask_min_stint_minutes");
    expect(warnings.join("\n")).toContain("stint_idle_minutes");
    expect(warnings.join("\n")).toContain("memory_stints");
  });

  test("the current [w5] key wins when both names are present, with one warning", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[w5]
activity_idle_minutes = 30
stint_idle_minutes = 45
`,
    );
    const warnings: string[] = [];
    const config = loadIntentConfig(path, (message) => warnings.push(message));

    expect(config.w5.stintIdleMinutes).toBe(45);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("stint_idle_minutes");
  });

  test("a config using only current key names warns about nothing", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, "\n[w5]\nstint_idle_minutes = 30\n");
    const warnings: string[] = [];
    const config = loadIntentConfig(path, (message) => warnings.push(message));

    expect(config.w5.stintIdleMinutes).toBe(30);
    expect(warnings).toEqual([]);
  });

  test("parses stint_idle_minutes, memory_hours, memory_stints, overlap_messages", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[w5]
stint_idle_minutes = 30
memory_hours = 4
memory_stints = 5
overlap_messages = 2
`,
    );
    const config = loadIntentConfig(path);
    expect(config.w5.stintIdleMinutes).toBe(30);
    expect(config.w5.memoryHours).toBe(4);
    expect(config.w5.memoryStints).toBe(5);
    expect(config.w5.overlapMessages).toBe(2);
  });

  test("defaultIntentConfig().w5 has the stint lifecycle defaults", () => {
    const config = defaultIntentConfig();
    expect(config.w5.stintIdleMinutes).toBe(45);
    expect(config.w5.memoryHours).toBe(8);
    expect(config.w5.memoryStints).toBe(10);
    expect(config.w5.overlapMessages).toBe(3);
  });

  test("parses w5 timeout_seconds", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `[w5]\ntimeout_seconds = 60\n`);
    const config = loadIntentConfig(path);
    expect(config.w5.timeoutSeconds).toBe(60);
  });

  test("parses w5 backend and claude_command", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[w5]
backend = "api"
claude_command = "/opt/bin/claude"
`,
    );
    const config = loadIntentConfig(path);
    expect(config.w5.backend).toBe("api");
    expect(config.w5.claudeCommand).toBe("/opt/bin/claude");
  });

  test("falls back to default backend on unknown value, and says so", () => {
    const warnings: string[] = [];
    const config = loadIntentConfig(writeToml(`[w5]\nbackend = "bogus"\n`), (message) =>
      warnings.push(message),
    );
    expect(config.w5.backend).toBe("claude-cli");
    expect(warnings).toEqual([
      'tempad.toml: [w5].backend must be one of "claude-cli", "api", got "bogus" (a string); using the default "claude-cli". Fix the value.',
    ]);
  });

  test("defaultIntentConfig reflects claude-cli defaults", () => {
    const config = defaultIntentConfig();
    expect(config.w5.backend).toBe("claude-cli");
    expect(config.w5.claudeCommand).toBe("claude");
  });

  test("rejects a party without slug", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `[[parties]]\nname = "x"\n`);
    expect(() => loadIntentConfig(path)).toThrow(/slug/);
  });

  test("a missing tempad.toml returns defaultIntentConfig instead of crashing (first-run hero init)", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    // deliberately do not create the file
    const config = loadIntentConfig(path);
    expect(config).toEqual(defaultIntentConfig());
  });

  test("parses w5 mode and inference_fallback", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[w5]
mode = "inferred"
inference_fallback = false
`,
    );
    const config = loadIntentConfig(path);
    expect(config.w5.mode).toBe("inferred");
    expect(config.w5.inferenceFallback).toBe(false);
  });

  test("defaultIntentConfig().w5 defaults to declared mode with inference fallback on", () => {
    const config = defaultIntentConfig();
    expect(config.w5.mode).toBe("declared");
    expect(config.w5.inferenceFallback).toBe(true);
  });

  test("loadIntentConfig reads stint_min_minutes, defaulting to 5", () => {
    expect(defaultIntentConfig().w5.stintMinMinutes).toBe(5);

    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `[w5]\nstint_min_minutes = 10\n`);
    const config = loadIntentConfig(path);
    expect(config.w5.stintMinMinutes).toBe(10);
  });
});

describe("a [w5] key of the wrong type", () => {
  function load(toml: string) {
    const warnings: { message: string; kind: ConfigWarningKind }[] = [];
    const config = loadIntentConfig(writeToml(toml), (message, kind) =>
      warnings.push({ message, kind }),
    );
    return { config, warnings };
  }

  test("keeps the default and warns with the key, the expected type and the value", () => {
    const { config, warnings } = load('[w5]\nstint_idle_minutes = "abc"\n');
    expect(config.w5.stintIdleMinutes).toBe(45);
    expect(warnings).toEqual([
      {
        message:
          'tempad.toml: [w5].stint_idle_minutes must be a number, got "abc" (a string); using the default 45. Fix the value.',
        kind: "wrong-type",
      },
    ]);
  });

  test("covers every number key, and leaves the right ones at their defaults", () => {
    const keys: [string, keyof ReturnType<typeof defaultIntentConfig>["w5"]][] = [
      ["throttle_minutes", "throttleMinutes"],
      ["watch_turns", "watchTurns"],
      ["ask_min_stint_minutes", "askMinStintMinutes"],
      ["ask_budget_minutes", "askBudgetMinutes"],
      ["ask_expire_turns", "askExpireTurns"],
      ["backfill_days", "backfillDays"],
      ["timeout_seconds", "timeoutSeconds"],
      ["stint_idle_minutes", "stintIdleMinutes"],
      ["stint_min_minutes", "stintMinMinutes"],
      ["memory_hours", "memoryHours"],
      ["memory_stints", "memoryStints"],
      ["overlap_messages", "overlapMessages"],
    ];
    const toml = `[w5]\n${keys.map(([key]) => `${key} = "x"`).join("\n")}\n`;
    const { config, warnings } = load(toml);
    expect(config.w5).toEqual(defaultIntentConfig().w5);
    expect(warnings.map((entry) => entry.message.match(/\[w5\]\.(\w+)/)?.[1])).toEqual(
      keys.map(([key]) => key),
    );
  });

  test("a boolean, a string and an array are each reported with their type", () => {
    const { config, warnings } = load(
      '[w5]\ninference_fallback = "yes"\nmodel = 5\nclaude_command = ["a"]\nwatch_turns = true\n',
    );
    expect(config.w5.inferenceFallback).toBe(true);
    expect(config.w5.model).toBe(defaultIntentConfig().w5.model);
    expect(config.w5.claudeCommand).toBe("claude");
    expect(config.w5.watchTurns).toBe(3);
    expect(warnings.map((entry) => entry.message)).toEqual([
      'tempad.toml: [w5].model must be a string, got 5 (a number); using the default "claude-haiku-4-5-20251001". Fix the value.',
      "tempad.toml: [w5].watch_turns must be a number, got true (a boolean); using the default 3. Fix the value.",
      'tempad.toml: [w5].claude_command must be a string, got ["a"] (an array); using the default "claude". Fix the value.',
      'tempad.toml: [w5].inference_fallback must be true or false, got "yes" (a string); using the default true. Fix the value.',
    ]);
  });

  test("an unknown mode or a non-string backend warns and keeps the default", () => {
    const { config, warnings } = load('[w5]\nmode = "guessing"\nbackend = 3\n');
    expect(config.w5.mode).toBe("declared");
    expect(config.w5.backend).toBe("claude-cli");
    expect(warnings.map((entry) => entry.message)).toEqual([
      'tempad.toml: [w5].backend must be one of "claude-cli", "api", got 3 (a number); using the default "claude-cli". Fix the value.',
      'tempad.toml: [w5].mode must be one of "declared", "inferred", got "guessing" (a string); using the default "declared". Fix the value.',
    ]);
  });

  test("a long value is cut so the warning stays on one line", () => {
    const { warnings } = load(`[w5]\nstint_idle_minutes = "${"x".repeat(200)}"\n`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message.length).toBeLessThan(250);
    expect(warnings[0]?.message).toContain("…");
  });

  test("a [w5] that is not a table warns once and every key stays at its default", () => {
    const { config, warnings } = load("w5 = 5\n");
    expect(config.w5).toEqual(defaultIntentConfig().w5);
    expect(warnings).toEqual([
      {
        message:
          "tempad.toml: [w5] must be a table, got 5 (a number); using the defaults for every [w5] key. Fix the value.",
        kind: "wrong-type",
      },
    ]);
  });

  test("a renamed key keeps its own kind, and a correct file warns about nothing", () => {
    const { warnings } = load('[w5]\nactivity_idle_minutes = 30\nwatch_turns = "x"\n');
    expect(warnings.map((entry) => entry.kind)).toEqual(["renamed-key", "wrong-type"]);
    expect(
      load('[w5]\nwatch_turns = 4\nmode = "inferred"\ninference_fallback = false\n').warnings,
    ).toEqual([]);
  });

  test("a legacy key with a wrong-typed value is reported under its current name", () => {
    const { config, warnings } = load('[w5]\nactivity_idle_minutes = "soon"\n');
    expect(config.w5.stintIdleMinutes).toBe(45);
    expect(warnings.map((entry) => entry.message).join("\n")).toContain(
      '[w5].stint_idle_minutes must be a number, got "soon"',
    );
  });

  test("without a callback the warning goes to stderr through console.warn", () => {
    const original = console.warn;
    const lines: string[] = [];
    console.warn = (message: string) => lines.push(message);
    try {
      loadIntentConfig(writeToml('[w5]\nstint_idle_minutes = "abc"\n'));
    } finally {
      console.warn = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[w5].stint_idle_minutes must be a number");
  });
});

describe("a [[parties]] key of the wrong type", () => {
  test("joined and description are ignored with a warning naming the entry", () => {
    const warnings: string[] = [];
    const config = loadIntentConfig(
      writeToml(
        '[[parties]]\nslug = "a"\nname = "A"\njoined = 2025\n[[parties]]\nslug = "b"\nname = "B"\ndescription = false\njoined = "2025-07-01"\n',
      ),
      (message) => warnings.push(message),
    );
    expect(config.parties[0]?.joined).toBeUndefined();
    expect(config.parties[1]?.description).toBeUndefined();
    expect(config.parties[1]?.joined).toBe("2025-07-01");
    expect(warnings).toEqual([
      "tempad.toml: [[parties]] #1.joined must be a string, got 2025 (a number); ignoring it. Fix the value.",
      "tempad.toml: [[parties]] #2.description must be a string, got false (a boolean); ignoring it. Fix the value.",
    ]);
  });
});
