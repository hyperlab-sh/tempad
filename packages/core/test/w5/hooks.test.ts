import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildAdditionalContext,
  buildBelongsHandback,
  buildDeclarationLine,
  buildDeclareHandback,
  installHooks,
  PLUGIN_RECOMMENDATION_MESSAGE,
  promptHookScriptPath,
  renderHookSettings,
  stopHookScriptPath,
  uninstallHooks,
} from "../../src/w5/hooks";
import type { QuestionRow } from "../../src/w5/questions";

const SYSTEM_PATH = "/usr/bin:/bin";
const HOOKS_DIRECTORY = join(import.meta.dir, "../../hooks");
const REPOSITORY_ROOT = join(import.meta.dir, "../../../..");

/** A TEMPAD_HOME that counts as configured; HOME and CLAUDE_PROJECT_DIR live inside it. */
function configuredHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
  writeFileSync(join(dir, ".env"), "");
  return dir;
}

/** Explicit env for a hook spawn: nothing inherited, HOME/TEMPAD_HOME/CLAUDE_PROJECT_DIR all temp. */
function hookEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: SYSTEM_PATH,
    HOME: join(dir, "home"),
    TEMPAD_HOME: dir,
    CLAUDE_PROJECT_DIR: join(dir, "project"),
    ...extra,
  };
}

const spoolFile = (dir: string): string => join(dir, "w5-spool");

/** The spool lines w5-stop.sh appended, split into [time, session, kind, forced]. */
function spooled(dir: string): string[][] {
  return readFileSync(spoolFile(dir), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
}

/** w5-stop.sh only spools; w5-prompt.sh calls the CLI. */
function hookRan(script: string, dir: string, argvLog: string): boolean {
  return existsSync(script === "w5-stop.sh" ? spoolFile(dir) : argvLog);
}

function writeFakeCli(path: string, argvLog: string, body = ""): void {
  writeFileSync(path, `#!/bin/sh\necho "$@" >> "${argvLog}"\n${body}`);
  chmodSync(path, 0o755);
}

async function runScript(
  script: "w5-stop.sh" | "w5-prompt.sh",
  payload: Record<string, string>,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bash", join(HOOKS_DIRECTORY, script)],
    env,
    stdin: new Response(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function writeLegacySettings(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  installHooks(path);
}

describe("renderHookSettings", () => {
  test("computes hook paths from the package location, not the bun binary, and writes absolute paths that exist on disk", () => {
    const fragment = renderHookSettings();
    const stopCommand = fragment.Stop[0]?.hooks[0]?.command ?? "";
    const promptCommand = fragment.UserPromptSubmit[0]?.hooks[0]?.command ?? "";

    const stopScript = stopHookScriptPath();
    const promptScript = promptHookScriptPath();

    expect(existsSync(stopScript)).toBe(true);
    expect(existsSync(promptScript)).toBe(true);
    expect(stopScript.startsWith("/")).toBe(true);
    expect(promptScript.startsWith("/")).toBe(true);

    expect(stopCommand).toContain(stopScript);
    expect(promptCommand).toContain(promptScript);
    expect(stopCommand).toMatch(/^TEMPAD_BIN="bun \/.*\/src\/cli\.ts" bash \/.*w5-stop\.sh$/);
  });

  test("marks every entry with tempad: true", () => {
    const fragment = renderHookSettings();
    expect(fragment.Stop[0]?.hooks[0]?.tempad).toBe(true);
    expect(fragment.PreCompact[0]?.hooks[0]?.tempad).toBe(true);
    expect(fragment.SessionEnd[0]?.hooks[0]?.tempad).toBe(true);
    expect(fragment.UserPromptSubmit[0]?.hooks[0]?.tempad).toBe(true);
  });
});

describe("installHooks / uninstallHooks", () => {
  test("creates the settings directory if it doesn't exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hooks-test-"));
    const nestedSettingsPath = join(dir, "nested", "does", "not", "exist", "settings.json");
    try {
      expect(existsSync(join(dir, "nested"))).toBe(false);
      installHooks(nestedSettingsPath);
      expect(existsSync(nestedSettingsPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installs alongside an unrelated existing Stop hook, is idempotent, uninstall removes only tempad entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hooks-test-"));
    const settingsPath = join(dir, "settings.json");
    try {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }],
          },
        }),
      );

      installHooks(settingsPath);
      const afterFirst = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommands = afterFirst.hooks.Stop.flatMap(
        (entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command),
      );
      expect(stopCommands).toContain("other-tool");
      expect(stopCommands.some((command: string) => command.includes("w5-stop.sh"))).toBe(true);

      installHooks(settingsPath);
      const afterSecond = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommandsSecond = afterSecond.hooks.Stop.flatMap(
        (entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command),
      );
      const tempadCount = stopCommandsSecond.filter((command: string) =>
        command.includes("w5-stop.sh"),
      ).length;
      expect(tempadCount).toBe(1);

      uninstallHooks(settingsPath);
      const afterUninstall = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommandsThird = afterUninstall.hooks.Stop.flatMap(
        (entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command),
      );
      expect(stopCommandsThird).toEqual(["other-tool"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--bin override is reflected in the written command", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hooks-test-"));
    const settingsPath = join(dir, "settings.json");
    try {
      installHooks(settingsPath, "/custom/path/cli.ts");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommand = settings.hooks.Stop[0].hooks[0].command as string;
      expect(stopCommand).toContain("bun /custom/path/cli.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildAdditionalContext", () => {
  test("renders the question id and the answer command", () => {
    const questions: QuestionRow[] = [
      {
        id: "Q1",
        traceId: "T1",
        sessionId: "s1",
        kind: "which_quest",
        state: "asked",
        turnsWatched: 3,
        turnsAtAsk: 3,
        isSwitch: true,
      },
    ];
    const text = buildAdditionalContext(questions);
    expect(text).toContain("Q1");
    // A classifier question is not a belongs question: `answer --belongs` would exit 2.
    expect(text).toContain('tempad answer Q1 --quest <quest-id> --why "<reason>"');
    expect(text).toContain('tempad answer Q1 --quest new:"<title>" --why "<reason>"');
    expect(text).not.toContain("--belongs");
    expect(text).not.toContain("<question-id>");
  });

  test("returns empty string for no questions", () => {
    expect(buildAdditionalContext([])).toBe("");
  });
});

describe("buildDeclarationLine", () => {
  test("renders 'none' when the session has declared nothing", () => {
    expect(buildDeclarationLine([], "s1")).toBe(
      "tempad: session s1, active quests: none. Declare with the tempad-quest skill if this prompt starts a different outcome.",
    );
  });

  test("names /tempad:quest when the hook runs from the plugin", () => {
    expect(buildDeclarationLine([], "s1", "plugin")).toBe(
      "tempad: session s1, active quests: none. Declare with /tempad:quest if this prompt starts a different outcome.",
    );
  });

  test("any other source keeps the legacy tempad-quest name", () => {
    expect(buildDeclarationLine([], "s1", undefined)).toContain("the tempad-quest skill");
    expect(buildDeclarationLine([], "s1", "legacy")).toContain("the tempad-quest skill");
  });

  test("renders every active quest bracket-tagged with its alias", () => {
    expect(
      buildDeclarationLine(
        [
          { title: "Ship X", alias: "Q1" },
          { title: "Fix Y", alias: "Q2" },
        ],
        "s1",
      ),
    ).toBe(
      "tempad: session s1, active quests: Ship X [Q1], Fix Y [Q2]. Declare with the tempad-quest skill if this prompt starts a different outcome.",
    );
  });
});

describe("w5-stop.sh", () => {
  const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;

  async function runStop(dir: string, hookEventName: string, extra: Record<string, string> = {}) {
    return runScript(
      "w5-stop.sh",
      { session_id: "s1", hook_event_name: hookEventName },
      hookEnv(dir, extra),
    );
  }

  test("appends one spool line per event: Stop plain, PreCompact forced, SessionEnd forced session_end", async () => {
    const dir = configuredHome();
    try {
      for (const event of ["Stop", "PreCompact", "SessionEnd"]) {
        expect(await runStop(dir, event)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      }

      const lines = spooled(dir);
      expect(lines.map(([, session, kind, forced]) => [session, kind, forced])).toEqual([
        ["s1", "classify", "0"],
        ["s1", "classify", "1"],
        ["s1", "session_end", "1"],
      ]);
      for (const [time] of lines) expect(time).toMatch(ISO_TIME);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never starts the CLI: it spools with TEMPAD_BIN set, and with no CLI at all, and logs nothing", async () => {
    const dir = configuredHome();
    try {
      const argvLog = join(dir, "argv.log");
      const fakeTempad = join(dir, "tempad");
      writeFakeCli(fakeTempad, argvLog);

      await runStop(dir, "Stop", { TEMPAD_BIN: fakeTempad });
      const result = await runStop(dir, "SessionEnd");

      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(existsSync(argvLog)).toBe(false);
      expect(spooled(dir)).toHaveLength(2);
      expect(existsSync(join(dir, "logs", "w5.log"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a spool that cannot be written logs one line and still exits 0 silently", async () => {
    const dir = configuredHome();
    try {
      mkdirSync(spoolFile(dir));

      const result = await runStop(dir, "Stop");

      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(readFileSync(join(dir, "logs", "w5.log"), "utf8")).toContain("could not append");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent hooks never interleave a line", async () => {
    const dir = configuredHome();
    try {
      await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          runScript(
            "w5-stop.sh",
            { session_id: `s${index}`, hook_event_name: "Stop" },
            hookEnv(dir),
          ),
        ),
      );

      const lines = spooled(dir);
      expect(lines).toHaveLength(24);
      expect(lines.map(([, session]) => session).sort()).toEqual(
        Array.from({ length: 24 }, (_, index) => `s${index}`).sort(),
      );
      for (const line of lines) expect(line).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w5-stop.sh / w5-prompt.sh injection safety", () => {
  test("a malicious session_id is rejected before reaching TEMPAD_BIN, no command execution", async () => {
    const dir = configuredHome();
    try {
      const fakeTempad = join(dir, "tempad");
      const argvLog = join(dir, "argv.log");
      const canaryFile = join(dir, "pwned");
      writeFileSync(fakeTempad, `#!/bin/sh\necho "$@" >> "${argvLog}"\n`);
      chmodSync(fakeTempad, 0o755);

      const scriptPath = join(import.meta.dir, "../../hooks/w5-stop.sh");
      const maliciousSessionId = `s1"; touch ${canaryFile}; echo "`;

      const proc = Bun.spawn({
        cmd: ["bash", scriptPath],
        env: hookEnv(dir, { TEMPAD_BIN: fakeTempad }),
        stdin: new Response(
          JSON.stringify({ session_id: maliciousSessionId, hook_event_name: "Stop" }),
        ),
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(existsSync(canaryFile)).toBe(false);
      expect(existsSync(argvLog)).toBe(false);
      expect(existsSync(spoolFile(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TEMPAD_BIN containing a semicolon does not execute a second command (no eval)", async () => {
    const dir = configuredHome();
    try {
      const canaryFile = join(dir, "pwned");
      const scriptPath = join(import.meta.dir, "../../hooks/w5-stop.sh");
      const maliciousBin = `true; touch ${canaryFile} #`;

      const proc = Bun.spawn({
        cmd: ["bash", scriptPath],
        env: hookEnv(dir, { TEMPAD_BIN: maliciousBin }),
        stdin: new Response(JSON.stringify({ session_id: "s1", hook_event_name: "Stop" })),
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;

      expect(existsSync(canaryFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifier hand-back text", () => {
  test("a belongs hand-back lists every active quest, the guess and both answer commands", () => {
    const text = buildBelongsHandback(
      [
        { title: "Ship marko-ui", alias: "Q1" },
        { title: "Fix the flake", alias: "Q2" },
      ],
      "a competitor comparison",
      "Q123",
    );

    expect(text).toBe(
      [
        "w5 thinks the last stretch is not part of your active quests (Ship marko-ui [Q1], Fix the flake [Q2]) (looks like: a competitor comparison). Reply with one of:",
        '  tempad answer Q123 --belongs --why "<reason>"',
        '  tempad answer Q123 --quest <quest-id> --why "<reason>"',
        '  tempad answer Q123 --quest new:"<title>" --why "<reason>" [--origin current --trigger "<sentence>" --kind <waiting|blocker|curiosity|unknown>]',
        "Ask the user if you are not sure.",
      ].join("\n"),
    );
  });

  test("a belongs hand-back falls back when no quest is active any more", () => {
    const text = buildBelongsHandback([], "a competitor comparison", "Q123");

    expect(text).toContain("not part of your active quests (none)");
  });

  test("a declare hand-back names the session and the declare command", () => {
    const text = buildDeclareHandback("s1");

    expect(text).toBe(
      [
        "w5 has no declared quest for this session. Reply with one of:",
        "  tempad quest declare --session s1 --quest <quest-id> --by agent",
        '  tempad quest declare --session s1 --new "<title>" --outcome "<text>" --by agent',
      ].join("\n"),
    );
  });

  test("buildAdditionalContext renders each verifier kind through its own hand-back", () => {
    const text = buildAdditionalContext(
      [
        {
          id: "Q1",
          traceId: "T1",
          sessionId: "s1",
          kind: "belongs",
          state: "asked",
          turnsWatched: 1,
          turnsAtAsk: 1,
          isSwitch: false,
        },
        {
          id: "Q2",
          traceId: "T2",
          sessionId: "s1",
          kind: "declare",
          state: "asked",
          turnsWatched: 1,
          turnsAtAsk: 1,
          isSwitch: false,
        },
      ],
      {
        activeQuests: [{ title: "Ship marko-ui", alias: "Q1" }],
        hasActiveDeclaration: true,
        sessionId: "s1",
        guessFor: (questionId) => (questionId === "Q1" ? "a competitor comparison" : null),
      },
    );

    expect(text).toContain(
      "not part of your active quests (Ship marko-ui [Q1]) (looks like: a competitor comparison)",
    );
    expect(text).toContain("tempad answer Q1 --belongs");
    // The session has an active quest, so a stale declare question stays silent.
    expect(text).not.toContain("w5 has no declared quest for this session");
  });

  test("buildAdditionalContext renders a declare question only while nothing is active", () => {
    const text = buildAdditionalContext(
      [
        {
          id: "Q2",
          traceId: "T2",
          sessionId: "s1",
          kind: "declare",
          state: "asked",
          turnsWatched: 1,
          turnsAtAsk: 1,
          isSwitch: false,
        },
      ],
      { activeQuests: [], hasActiveDeclaration: false, sessionId: "s1", guessFor: () => null },
    );

    expect(text).toContain("w5 has no declared quest for this session");
    expect(text).toContain("tempad quest declare --session s1");
  });
});

describe("hook scripts: configuration and stand-down", () => {
  const stopPayload = { session_id: "s1", hook_event_name: "Stop" };

  test("an unconfigured home exits 0 silently and is never created", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
    try {
      const home = join(parent, "never-created");
      const argvLog = join(parent, "argv.log");
      const fakeCli = join(parent, "tempad");
      writeFakeCli(fakeCli, argvLog);
      const env = hookEnv(home, { TEMPAD_BIN: fakeCli, HOME: join(parent, "home") });

      for (const script of ["w5-stop.sh", "w5-prompt.sh"] as const) {
        const result = await runScript(script, stopPayload, env);
        expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      }
      const malformed = await runScript("w5-stop.sh", { session_id: "bad id!" }, env);
      expect(malformed).toEqual({ exitCode: 0, stdout: "", stderr: "" });

      expect(existsSync(home)).toBe(false);
      expect(existsSync(argvLog)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a home holding only tempad.db counts as configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
    try {
      writeFileSync(join(dir, "tempad.db"), "");
      const argvLog = join(dir, "argv.log");
      const fakeCli = join(dir, "tempad");
      writeFakeCli(fakeCli, argvLog);

      await runScript("w5-stop.sh", stopPayload, hookEnv(dir, { TEMPAD_BIN: fakeCli }));

      expect(spooled(dir).map(([, session, kind]) => [session, kind])).toEqual([
        ["s1", "classify"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no session id exits 0 silently", async () => {
    const dir = configuredHome();
    try {
      const result = await runScript("w5-prompt.sh", {}, hookEnv(dir));
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const script of ["w5-stop.sh", "w5-prompt.sh"] as const) {
    test(`${script}: plugin source stands down for a legacy hook in user settings`, async () => {
      const dir = configuredHome();
      try {
        const argvLog = join(dir, "argv.log");
        const fakeCli = join(dir, "tempad");
        writeFakeCli(fakeCli, argvLog, "echo context-line\n");
        writeLegacySettings(join(dir, "home", ".claude", "settings.json"));

        const result = await runScript(
          script,
          stopPayload,
          hookEnv(dir, { TEMPAD_BIN: fakeCli, TEMPAD_HOOK_SOURCE: "plugin" }),
        );

        expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
        expect(hookRan(script, dir, argvLog)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${script}: plugin source stands down for a legacy hook in CLAUDE_PROJECT_DIR settings`, async () => {
      const dir = configuredHome();
      try {
        const argvLog = join(dir, "argv.log");
        const fakeCli = join(dir, "tempad");
        writeFakeCli(fakeCli, argvLog, "echo context-line\n");
        writeLegacySettings(join(dir, "project", ".claude", "settings.json"));

        const result = await runScript(
          script,
          stopPayload,
          hookEnv(dir, { TEMPAD_BIN: fakeCli, TEMPAD_HOOK_SOURCE: "plugin" }),
        );

        expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
        expect(hookRan(script, dir, argvLog)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${script}: legacy invocation (no TEMPAD_HOOK_SOURCE) still runs with the marker present`, async () => {
      const dir = configuredHome();
      try {
        const argvLog = join(dir, "argv.log");
        const fakeCli = join(dir, "tempad");
        writeFakeCli(fakeCli, argvLog, "echo context-line\n");
        writeLegacySettings(join(dir, "home", ".claude", "settings.json"));

        await runScript(script, stopPayload, hookEnv(dir, { TEMPAD_BIN: fakeCli }));

        expect(hookRan(script, dir, argvLog)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("plugin source stands down for a legacy hook in CLAUDE_CONFIG_DIR/settings.json", async () => {
    const dir = configuredHome();
    try {
      const argvLog = join(dir, "argv.log");
      const fakeCli = join(dir, "tempad");
      writeFakeCli(fakeCli, argvLog);
      const configDirectory = join(dir, "work-account");
      writeLegacySettings(join(configDirectory, "settings.json"));

      const env = hookEnv(dir, { TEMPAD_BIN: fakeCli, TEMPAD_HOOK_SOURCE: "plugin" });
      const withoutConfigDir = await runScript("w5-stop.sh", stopPayload, env);
      expect(withoutConfigDir.exitCode).toBe(0);
      expect(existsSync(spoolFile(dir))).toBe(true);
      rmSync(spoolFile(dir));

      const result = await runScript("w5-stop.sh", stopPayload, {
        ...env,
        CLAUDE_CONFIG_DIR: configDirectory,
      });
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(existsSync(spoolFile(dir))).toBe(false);

      // Legacy invocation is never affected by it.
      await runScript("w5-stop.sh", stopPayload, {
        ...hookEnv(dir, { TEMPAD_BIN: fakeCli }),
        CLAUDE_CONFIG_DIR: configDirectory,
      });
      expect(existsSync(spoolFile(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with CLAUDE_CONFIG_DIR set, a stale legacy entry in $HOME/.claude does not make the plugin stand down", async () => {
    const dir = configuredHome();
    try {
      const argvLog = join(dir, "argv.log");
      const fakeCli = join(dir, "tempad");
      writeFakeCli(fakeCli, argvLog);
      writeLegacySettings(join(dir, "home", ".claude", "settings.json"));
      const configDirectory = join(dir, "work-account");
      mkdirSync(configDirectory, { recursive: true });
      writeFileSync(join(configDirectory, "settings.json"), "{}");

      const result = await runScript("w5-stop.sh", stopPayload, {
        ...hookEnv(dir, { TEMPAD_BIN: fakeCli, TEMPAD_HOOK_SOURCE: "plugin" }),
        CLAUDE_CONFIG_DIR: configDirectory,
      });
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(existsSync(spoolFile(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty CLAUDE_CONFIG_DIR means $HOME/.claude/settings.json", async () => {
    const dir = configuredHome();
    try {
      const argvLog = join(dir, "argv.log");
      const fakeCli = join(dir, "tempad");
      writeFakeCli(fakeCli, argvLog);
      writeLegacySettings(join(dir, "home", ".claude", "settings.json"));

      const result = await runScript("w5-stop.sh", stopPayload, {
        ...hookEnv(dir, { TEMPAD_BIN: fakeCli, TEMPAD_HOOK_SOURCE: "plugin" }),
        CLAUDE_CONFIG_DIR: "",
      });
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(existsSync(spoolFile(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TEMPAD_HOME with a leading ~ or ~/ is expanded like tempadHome() does", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
    try {
      const fakeHome = join(parent, "home");
      mkdirSync(join(fakeHome, ".tempad-work"), { recursive: true });
      writeFileSync(join(fakeHome, ".tempad-work", ".env"), "");
      const argvLog = join(parent, "argv.log");
      const fakeCli = join(parent, "tempad");
      writeFakeCli(fakeCli, argvLog);
      const env = {
        PATH: SYSTEM_PATH,
        HOME: fakeHome,
        TEMPAD_BIN: fakeCli,
        TEMPAD_HOME: "~/.tempad-work",
      };

      const result = await runScript("w5-stop.sh", stopPayload, env);
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(readFileSync(join(fakeHome, ".tempad-work", "w5-spool"), "utf8")).toContain(
        "\ts1\tclassify\t0\n",
      );

      // A bare ~ is the home directory itself.
      writeFileSync(join(fakeHome, ".env"), "");
      await runScript("w5-stop.sh", stopPayload, { ...env, TEMPAD_HOME: "~" });
      expect(existsSync(join(fakeHome, "w5-spool"))).toBe(true);

      // A literal directory named "~" in the working directory is not what ~/ means.
      await runScript("w5-stop.sh", stopPayload, { ...env, TEMPAD_HOME: "~other" });
      expect(existsSync(join(fakeHome, "other", "w5-spool"))).toBe(false);
      expect(existsSync(join(parent, "w5-spool"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("plugin source runs when settings exist but carry no tempad marker", async () => {
    const dir = configuredHome();
    try {
      const argvLog = join(dir, "argv.log");
      const fakeCli = join(dir, "tempad");
      writeFakeCli(fakeCli, argvLog);
      const settingsPath = join(dir, "home", ".claude", "settings.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } }),
      );

      await runScript(
        "w5-stop.sh",
        stopPayload,
        hookEnv(dir, { TEMPAD_BIN: fakeCli, TEMPAD_HOOK_SOURCE: "plugin" }),
      );

      expect(existsSync(spoolFile(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the marker is matched with whitespace variations", async () => {
    const dir = configuredHome();
    try {
      const argvLog = join(dir, "argv.log");
      const fakeCli = join(dir, "tempad");
      writeFakeCli(fakeCli, argvLog);
      const settingsPath = join(dir, "home", ".claude", "settings.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, '{"hooks":{"Stop":[{"hooks":[{"tempad"  :   true}]}]}}');

      await runScript(
        "w5-stop.sh",
        stopPayload,
        hookEnv(dir, { TEMPAD_BIN: fakeCli, TEMPAD_HOOK_SOURCE: "plugin" }),
      );

      expect(existsSync(spoolFile(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hook scripts: CLI resolution", () => {
  const stopPayload = { session_id: "s1", hook_event_name: "Stop" };

  test("falls back to a tempad on PATH when TEMPAD_BIN is unset", async () => {
    const dir = configuredHome();
    try {
      const binDirectory = join(dir, "bin");
      mkdirSync(binDirectory);
      const argvLog = join(dir, "argv.log");
      writeFakeCli(join(binDirectory, "tempad"), argvLog);

      const result = await runScript(
        "w5-prompt.sh",
        stopPayload,
        hookEnv(dir, { PATH: `${binDirectory}:${SYSTEM_PATH}` }),
      );

      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(readFileSync(argvLog, "utf8").trim()).toBe("w5 context --session s1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to bunx @hyperlab.sh/tempad when only bun is on PATH", async () => {
    const dir = configuredHome();
    try {
      const binDirectory = join(dir, "bin");
      mkdirSync(binDirectory);
      const argvLog = join(dir, "argv.log");
      writeFakeCli(join(binDirectory, "bun"), argvLog);

      await runScript(
        "w5-prompt.sh",
        { session_id: "s1", hook_event_name: "SessionEnd" },
        hookEnv(dir, { PATH: `${binDirectory}:${SYSTEM_PATH}` }),
      );

      expect(readFileSync(argvLog, "utf8").trim()).toBe(
        "x @hyperlab.sh/tempad w5 context --session s1",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prefers TEMPAD_BIN over tempad on PATH, and tempad on PATH over bun", async () => {
    const dir = configuredHome();
    try {
      const binDirectory = join(dir, "bin");
      mkdirSync(binDirectory);
      const pathLog = join(dir, "path.log");
      const bunLog = join(dir, "bun.log");
      const explicitLog = join(dir, "explicit.log");
      writeFakeCli(join(binDirectory, "tempad"), pathLog);
      writeFakeCli(join(binDirectory, "bun"), bunLog);
      const explicit = join(dir, "explicit");
      writeFakeCli(explicit, explicitLog);
      const pathEnv = { PATH: `${binDirectory}:${SYSTEM_PATH}` };

      await runScript(
        "w5-prompt.sh",
        stopPayload,
        hookEnv(dir, { ...pathEnv, TEMPAD_BIN: explicit }),
      );
      expect(existsSync(explicitLog)).toBe(true);
      expect(existsSync(pathLog)).toBe(false);

      await runScript("w5-prompt.sh", stopPayload, hookEnv(dir, pathEnv));
      expect(existsSync(pathLog)).toBe(true);
      expect(existsSync(bunLog)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("nothing resolvable exits 0 silently on both scripts", async () => {
    const dir = configuredHome();
    try {
      for (const script of ["w5-stop.sh", "w5-prompt.sh"] as const) {
        const result = await runScript(script, stopPayload, hookEnv(dir));
        expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      }
      expect(readFileSync(join(dir, "logs", "w5.log"), "utf8")).toContain("no tempad CLI found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI stderr goes to w5.log, never to the hook's stderr (the stop script no longer calls the CLI)", async () => {
    const dir = configuredHome();
    try {
      const fakeCli = join(dir, "tempad");
      writeFileSync(fakeCli, '#!/bin/sh\necho "boom from cli" >&2\necho "ctx line"\nexit 3\n');
      chmodSync(fakeCli, 0o755);

      const stop = await runScript(
        "w5-stop.sh",
        stopPayload,
        hookEnv(dir, { TEMPAD_BIN: fakeCli }),
      );
      const prompt = await runScript(
        "w5-prompt.sh",
        stopPayload,
        hookEnv(dir, { TEMPAD_BIN: fakeCli }),
      );

      expect(stop).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(prompt.exitCode).toBe(0);
      expect(prompt.stderr).toBe("");
      expect(
        readFileSync(join(dir, "logs", "w5.log"), "utf8").match(/boom from cli/g),
      ).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tab, CR and other control characters in the context still produce valid JSON", async () => {
    const dir = configuredHome();
    try {
      const fakeCli = join(dir, "tempad");
      writeFileSync(
        fakeCli,
        "#!/bin/sh\nprintf 'Fix\\tthe \"flake\" \\\\ ok\\r\\nline2\\001\\033 end\\n'\n",
      );
      chmodSync(fakeCli, 0o755);

      const result = await runScript(
        "w5-prompt.sh",
        stopPayload,
        hookEnv(dir, { TEMPAD_BIN: fakeCli }),
      );

      expect(result.stdout.endsWith("\n")).toBe(true);
      expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: 'Fix\tthe "flake" \\ ok\nline2 end\n',
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the prompt script's JSON output format is unchanged", async () => {
    const dir = configuredHome();
    try {
      const fakeCli = join(dir, "tempad");
      writeFileSync(fakeCli, "#!/bin/sh\nprintf 'say \"hi\"\\nsecond\\n'\n");
      chmodSync(fakeCli, 0o755);

      const result = await runScript(
        "w5-prompt.sh",
        stopPayload,
        hookEnv(dir, { TEMPAD_BIN: fakeCli }),
      );

      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: 'say "hi"\nsecond\n',
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plugin manifest and hooks.json", () => {
  const hooksJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "hooks", "hooks.json"), "utf8"));

  test("hooks.json has the hooks wrapper and registers the four events", () => {
    expect(Object.keys(hooksJson)).toEqual(["hooks"]);
    expect(Object.keys(hooksJson.hooks).sort()).toEqual(
      ["PreCompact", "SessionEnd", "Stop", "UserPromptSubmit"].sort(),
    );
  });

  test("every command is a quoted CLAUDE_PLUGIN_ROOT script with the plugin source and no absolute path", () => {
    const expected: Record<string, string> = {
      Stop: "w5-stop.sh",
      PreCompact: "w5-stop.sh",
      SessionEnd: "w5-stop.sh",
      UserPromptSubmit: "w5-prompt.sh",
    };
    for (const [eventName, script] of Object.entries(expected)) {
      const entries = hooksJson.hooks[eventName] as {
        hooks: { type: string; command: string; timeout: number }[];
      }[];
      expect(entries).toHaveLength(1);
      const hook = entries[0]?.hooks[0];
      expect(hook?.type).toBe("command");
      expect(hook?.command).toBe(
        `TEMPAD_HOOK_SOURCE=plugin bash "\${CLAUDE_PLUGIN_ROOT}/packages/core/hooks/${script}"`,
      );
      expect(typeof hook?.timeout).toBe("number");
      expect(existsSync(join(REPOSITORY_ROOT, "packages", "core", "hooks", script))).toBe(true);
    }
    expect(hooksJson.hooks.UserPromptSubmit[0].hooks[0].timeout).toBeLessThanOrEqual(15);
  });

  test("Stop, PreCompact and SessionEnd run async; UserPromptSubmit stays synchronous (its stdout is the context)", () => {
    for (const eventName of ["Stop", "PreCompact", "SessionEnd"]) {
      expect(hooksJson.hooks[eventName][0].hooks[0].async).toBe(true);
    }
    expect(hooksJson.hooks.UserPromptSubmit[0].hooks[0].async).toBeUndefined();
  });

  test("no absolute path appears anywhere outside CLAUDE_PLUGIN_ROOT", () => {
    const raw = readFileSync(join(REPOSITORY_ROOT, "hooks", "hooks.json"), "utf8");
    expect(raw).not.toContain("/Users");
    expect(raw).not.toContain("/home/");
    expect(raw.replaceAll("$" + "{CLAUDE_PLUGIN_ROOT}/", "")).not.toMatch(/(^|[\s"=])\/[A-Za-z]/);
  });

  test("plugin.json version equals the core package version and points at the skills directory", () => {
    const plugin = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
    );
    const corePackage = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, "packages", "core", "package.json"), "utf8"),
    );
    expect(plugin.name).toBe("tempad");
    expect(plugin.version).toBe(corePackage.version);
    expect(plugin.skills).toBe("./packages/core/skills/");
    expect(
      existsSync(join(REPOSITORY_ROOT, "packages", "core", "skills", "quest", "SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(REPOSITORY_ROOT, ".claude-plugin", "marketplace.json"))).toBe(false);
  });

  test("the install recommendation names the plugin command and the stand-down rule", () => {
    expect(PLUGIN_RECOMMENDATION_MESSAGE).toContain("claude plugin install tempad@hyperlab");
    expect(PLUGIN_RECOMMENDATION_MESSAGE).toContain("stand down");
    expect(PLUGIN_RECOMMENDATION_MESSAGE).not.toContain("\n");
  });
});
