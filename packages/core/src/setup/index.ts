import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir as osHomedir, hostname as osHostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { childEnvironment } from "../config/child-env.ts";
import { ENV_VARS, type EnvVar, readDotEnv, SETUP_VARS } from "../config/env.ts";
import { hasTempadHooks, settingsPathFor } from "../w5/hooks.ts";
import { flagNameFor, renderEnvFile } from "./env-file.ts";
import {
  createPrompter,
  InputAborted,
  InputEnded,
  type Prompter,
  type PromptInput,
} from "./prompt.ts";
import { detectSuggestions } from "./suggest.ts";
import { renderTomlFile } from "./toml-file.ts";
import {
  describeInvalidValue,
  type Finding,
  type SpawnFunction,
  splitList,
  validateExternal,
  validateFormat,
} from "./validate.ts";

const CHECK_TIMEOUT_MS = 5000;
const DETECT_TIMEOUT_MS = 3000;

export const SETUP_USAGE =
  "tempad setup [--non-interactive] [--home <dir>] [--force] [--no-verify] [--<variable> <value> ...]";

/** Everything `runSetup` touches outside the file system, injectable so tests never hit the network. */
export interface SetupDeps {
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
  stdin: PromptInput;
  /** Whether `stdin` is a terminal; the wizard refuses to run without one. */
  isTTY: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch: typeof fetch;
  spawn: SpawnFunction;
  hostname: () => string;
  timeZone: () => string;
  /** Limit of each validation check. */
  timeoutMs: number;
  /** Limit of each prompt-suggestion command. */
  detectTimeoutMs: number;
}

/** Spawns a program with stdin closed; kills it at the time limit. Rejects when it cannot start. */
export const spawnWithTimeout: SpawnFunction = async (command, { timeoutMs }) => {
  const child = Bun.spawn(command, {
    // `gh auth status` and `gh api user` honour GH_TOKEN; the other secrets are of no use to them.
    env: childEnvironment(["GH_TOKEN"]),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { exitCode, stdout, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

export function defaultSetupDeps(): SetupDeps {
  return {
    env: process.env,
    homedir: process.env.HOME ?? osHomedir(),
    stdin: process.stdin,
    isTTY: process.stdin.isTTY === true,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    fetch: globalThis.fetch,
    spawn: spawnWithTimeout,
    hostname: osHostname,
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeoutMs: CHECK_TIMEOUT_MS,
    detectTimeoutMs: DETECT_TIMEOUT_MS,
  };
}

function expandTilde(path: string, home: string): string {
  return path.startsWith("~") ? join(home, path.slice(1)) : path;
}

/** Same normalization `loadConfig` applies, so the written value reads back unchanged. */
function normalizeValue(variable: EnvVar, raw: string): string {
  const trimmed = raw.trim();
  if (variable.kind === "list") return splitList(trimmed).join(",");
  if (variable.kind === "boolean") return trimmed.toLowerCase();
  return trimmed;
}

function levelLabel(level: Finding["level"]): string {
  if (level === "ok") return "ok";
  if (level === "error") return "error";
  if (level === "unverified") return "not verified";
  return "warning";
}

function blocking(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.level === "error" || finding.level === "unverified");
}

/** The user `settings.json` a legacy `tempad w5 hook install` may have written to. */
function legacyHookSettingsPath(deps: SetupDeps): string {
  return settingsPathFor("user", {
    CLAUDE_CONFIG_DIR: deps.env.CLAUDE_CONFIG_DIR,
    HOME: deps.homedir,
  });
}

interface Options {
  nonInteractive: boolean;
  force: boolean;
  verify: boolean;
  home: string;
  /** Values given as flags (not process.env), keyed by variable name. */
  flagValues: Map<string, string>;
}

function parseOptions(args: string[], deps: SetupDeps): Options {
  const { values } = parseArgs({
    args,
    options: {
      "non-interactive": { type: "boolean", default: false },
      home: { type: "string" },
      force: { type: "boolean", default: false },
      "no-verify": { type: "boolean", default: false },
      ...Object.fromEntries(
        SETUP_VARS.map((variable) => [flagNameFor(variable), { type: "string" as const }]),
      ),
    },
    strict: true,
    allowPositionals: false,
  });
  const flagValues = new Map<string, string>();
  for (const variable of SETUP_VARS) {
    const value = (values as Record<string, string | boolean | undefined>)[flagNameFor(variable)];
    if (typeof value === "string") flagValues.set(variable.name, value);
  }
  const configuredHome = values.home ?? deps.env.TEMPAD_HOME;
  return {
    nonInteractive: values["non-interactive"] === true,
    force: values.force === true,
    verify: values["no-verify"] !== true,
    home: configuredHome
      ? resolve(expandTilde(configuredHome, deps.homedir))
      : join(deps.homedir, ".tempad"),
    flagValues,
  };
}

/** Writes through a temp file and a rename, so a crash never leaves a half-written `.env`. */
function writeFileAtomic(path: string, content: string, mode: number): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function backUp(path: string, mode: number): void {
  const backup = `${path}.bak`;
  copyFileSync(path, backup);
  chmodSync(backup, mode);
}

interface Plan {
  home: string;
  values: Record<string, string>;
  /** Variables of the existing `.env` that `SETUP_VARS` does not list; kept on an in-place update. */
  extras: Record<string, string>;
  replaceToml: boolean;
}

function writeFiles(plan: Plan): { env: string; toml: "written" | "kept" } {
  mkdirSync(plan.home, { recursive: true, mode: 0o700 });
  const envPath = join(plan.home, ".env");
  const tomlPath = join(plan.home, "tempad.toml");

  if (existsSync(envPath)) backUp(envPath, 0o600);
  writeFileAtomic(envPath, renderEnvFile(plan.values, plan.extras), 0o600);

  const tomlExists = existsSync(tomlPath);
  if (tomlExists && !plan.replaceToml) return { env: envPath, toml: "kept" };
  if (tomlExists) backUp(tomlPath, 0o644);
  writeFileAtomic(tomlPath, renderTomlFile(), 0o644);
  return { env: envPath, toml: "written" };
}

function describeValue(variable: EnvVar, value: string | undefined): string {
  if (variable.secret) return value ? "set" : "not set";
  return value ? value : "not set";
}

/**
 * `tempad setup`: creates `TEMPAD_HOME` with a private `.env` and a commented `tempad.toml`.
 * Needs no configuration and never opens the database. Returns the exit code: 0 done,
 * 1 refused or failed, 2 bad usage, 130 aborted with Ctrl-C (nothing written).
 */
export async function runSetup(
  args: string[],
  overrides: Partial<SetupDeps> = {},
): Promise<number> {
  const deps: SetupDeps = { ...defaultSetupDeps(), ...overrides };
  const secrets = new Set<string>();
  const redact = (text: string): string => {
    let result = text;
    for (const secret of secrets) result = result.split(secret).join("***");
    return result;
  };
  const out = (text: string): void => deps.stdout(redact(text));
  const err = (text: string): void => deps.stderr(redact(text));
  const outLine = (text = ""): void => out(`${text}\n`);
  const errLine = (text: string): void => err(`${text}\n`);

  let options: Options;
  try {
    options = parseOptions(args, deps);
  } catch (error) {
    errLine(`tempad setup: ${error instanceof Error ? error.message : String(error)}`);
    errLine(`usage: ${SETUP_USAGE}`);
    return 2;
  }

  const noteSecrets = (values: Iterable<[string, string | undefined]>): void => {
    for (const [name, value] of values) {
      const variable = ENV_VARS.find((candidate) => candidate.name === name);
      if (variable?.secret && value && value.length >= 4) secrets.add(value);
    }
  };

  if (!options.nonInteractive && !deps.isTTY) {
    errLine(
      "tempad setup: stdin is not a terminal, so it cannot ask questions. " +
        `Rerun with --non-interactive and one flag per variable, e.g. ${SETUP_VARS.filter(
          (variable) => !variable.optional,
        )
          .slice(0, 2)
          .map((variable) => `--${flagNameFor(variable)} <value>`)
          .join(" ")} ...`,
    );
    return 1;
  }

  const envPath = join(options.home, ".env");
  const envExists = existsSync(envPath);
  const existing = envExists ? readDotEnv(options.home) : {};
  noteSecrets(Object.entries(existing));
  noteSecrets(options.flagValues);
  noteSecrets(ENV_VARS.map((variable) => [variable.name, deps.env[variable.name]]));

  if (options.nonInteractive && envExists && !options.force) {
    errLine(`tempad setup: ${envPath} already exists; rerun with --force to overwrite it`);
    return 1;
  }

  const prompter: Prompter | undefined = options.nonInteractive
    ? undefined
    : createPrompter(deps.stdin, out);

  try {
    const values: Record<string, string> = {};

    if (prompter === undefined) {
      const missing: string[] = [];
      for (const variable of SETUP_VARS) {
        const raw = options.flagValues.get(variable.name) ?? deps.env[variable.name] ?? "";
        const value = normalizeValue(variable, raw);
        if (value === "" && !variable.optional) {
          missing.push(`${variable.name} (--${flagNameFor(variable)})`);
        }
        values[variable.name] = value;
      }
      if (missing.length > 0) {
        errLine(`tempad setup: missing required value(s): ${missing.join(", ")}`);
        errLine("Pass each as a flag, or set it in the environment.");
        return 1;
      }
      const invalid = validateFormat(SETUP_VARS, values);
      if (invalid.length > 0) {
        for (const finding of invalid) errLine(`tempad setup: ${finding.message}`);
        return 1;
      }
    } else {
      outLine(`tempad setup: setting up ${options.home}`);
      if (envExists && !options.force) {
        const proceed = await prompter.confirm(`${envPath} already exists. Update it?`);
        if (!proceed) {
          outLine("Nothing changed.");
          return 0;
        }
      }
      outLine("Secrets are read without echo. Enter accepts the value in [brackets].");
      const detected = await detectSuggestions({
        spawn: deps.spawn,
        homedir: deps.homedir,
        env: deps.env,
        hostname: deps.hostname,
        timeZone: deps.timeZone,
        timeoutMs: deps.detectTimeoutMs,
      });

      for (const variable of SETUP_VARS) {
        const suggestion =
          options.flagValues.get(variable.name) ??
          existing[variable.name] ??
          detected[variable.name];
        outLine();
        outLine(`${variable.description}`);
        let hint = "";
        if (suggestion !== undefined && suggestion !== "") {
          hint = variable.secret ? " (keep current)" : ` [${suggestion}]`;
          if (variable.optional) hint += ' ("-" removes it)';
        } else if (variable.optional) {
          hint = " (optional, Enter to skip)";
        }
        for (;;) {
          const answer = (
            await prompter.ask(`${variable.name}${hint}: `, { hidden: variable.secret })
          ).trim();
          let value: string;
          if (answer === "") {
            if (suggestion !== undefined && suggestion !== "") value = suggestion;
            else if (variable.optional) value = "";
            else {
              outLine("  a value is required");
              continue;
            }
          } else if (answer === "-" && variable.optional && suggestion) {
            value = "";
          } else {
            value = answer;
          }
          value = normalizeValue(variable, value);
          const problem = describeInvalidValue(variable, value);
          if (problem !== undefined) {
            outLine(`  ${problem}`);
            continue;
          }
          values[variable.name] = value;
          noteSecrets([[variable.name, value]]);
          break;
        }
      }
    }

    if (options.verify) {
      outLine();
      outLine("Checking the values...");
      const findings = await validateExternal(values, {
        fetch: deps.fetch,
        spawn: deps.spawn,
        timeoutMs: deps.timeoutMs,
        homedir: deps.homedir,
      });
      for (const finding of findings) outLine(`  ${levelLabel(finding.level)}: ${finding.message}`);
      const problems = blocking(findings);
      if (problems.length > 0) {
        if (prompter === undefined) {
          errLine(
            `tempad setup: ${problems.length} check(s) failed or could not be verified; fix them or rerun with --no-verify`,
          );
          return 1;
        }
        outLine();
        const proceed = await prompter.confirm("Write the files anyway?");
        if (!proceed) {
          outLine("Nothing written.");
          return 1;
        }
      }
    }

    const knownNames = new Set(SETUP_VARS.map((variable) => variable.name));
    const extras: Record<string, string> = {};
    // Lines tempad does not own (e.g. ANTHROPIC_API_KEY) survive every rewrite, --force included.
    for (const [name, value] of Object.entries(existing)) {
      if (!knownNames.has(name)) extras[name] = value;
    }

    const written = writeFiles({
      home: options.home,
      values,
      extras,
      replaceToml: options.force,
    });

    outLine();
    outLine(`Wrote ${written.env} (mode 600)`);
    outLine(
      written.toml === "written"
        ? `Wrote ${join(options.home, "tempad.toml")}`
        : `Kept the existing ${join(options.home, "tempad.toml")} (--force replaces it)`,
    );
    outLine();
    outLine("Configuration:");
    for (const variable of SETUP_VARS) {
      outLine(`  ${variable.name}=${describeValue(variable, values[variable.name])}`);
    }

    const legacy = (() => {
      try {
        return hasTempadHooks(legacyHookSettingsPath(deps));
      } catch {
        return false;
      }
    })();
    outLine();
    outLine("Next steps (use `bunx @hyperlab.sh/tempad` where tempad is not on your PATH):");
    outLine("  claude plugin install tempad@hyperlab");
    outLine('  tempad hero init "<your name>"');
    outLine("  tempad sync");
    if (legacy) {
      outLine(
        "  tempad w5 hook uninstall   (settings.json still has the old tempad hooks; the plugin's hooks stand down until you remove them)",
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof InputAborted) {
      errLine("tempad setup: aborted; nothing was written");
      return 130;
    }
    if (error instanceof InputEnded) {
      errLine(`tempad setup: ${error.message}; nothing was written`);
      return 1;
    }
    errLine(`tempad setup: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    prompter?.close();
  }
}
