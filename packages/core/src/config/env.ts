import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  mondayApiToken: string;
  mondayUser: string;
  ghUser: string;
  ghOrgs: string[];
  ghIncludePersonal: boolean;
  ghToken: string | undefined;
  gitAuthorEmails: string[];
  claudeDirs: string[];
  hostSlug: string;
  tz: string;
  since: string;
  home: string;
}

/** A `Config` field that comes from an environment variable (everything but `home`). */
export type ConfigKey = Exclude<keyof Config, "home">;

/** What `loadConfig` returns: exactly the requested fields, plus the resolved home. */
export type LoadedConfig<K extends ConfigKey> = Pick<Config, K> & { home: string };

/** For code that needs the tempad home and nothing else from the environment. */
export type HomeConfig = LoadedConfig<never>;

export type EnvVarKind = "string" | "list" | "boolean";

export interface EnvVar {
  /** Environment variable name, as written in `.env`. */
  name: string;
  /** The `Config` field the variable fills. */
  key: ConfigKey;
  description: string;
  /** Secrets are read without echo by `tempad setup` and shown as `set`, never printed. */
  secret: boolean;
  kind: EnvVarKind;
  /** Optional variables never make a command fail when absent. */
  optional?: true;
}

/**
 * The one table of every environment variable tempad reads. `loadConfig`,
 * `tempad setup` and the error messages all read this; nothing else lists names.
 */
export const ENV_VARS: readonly EnvVar[] = [
  {
    name: "MONDAY_API_TOKEN",
    key: "mondayApiToken",
    description: "Monday.com API token (personal API token from the Monday admin page)",
    secret: true,
    kind: "string",
  },
  {
    name: "MONDAY_USER",
    key: "mondayUser",
    description: "Your Monday.com user: numeric id or display name",
    secret: false,
    kind: "string",
  },
  {
    name: "GH_USER",
    key: "ghUser",
    description: "Your GitHub login",
    secret: false,
    kind: "string",
  },
  {
    name: "GH_ORGS",
    key: "ghOrgs",
    description: "Comma-separated GitHub organizations to mirror",
    secret: false,
    kind: "list",
  },
  {
    name: "GH_INCLUDE_PERSONAL",
    key: "ghIncludePersonal",
    description: "Also mirror your personal repositories (true or false)",
    secret: false,
    kind: "boolean",
  },
  {
    name: "GH_TOKEN",
    key: "ghToken",
    description: "GitHub token; optional, `gh auth` credentials are used when unset",
    secret: true,
    kind: "string",
    optional: true,
  },
  {
    name: "GIT_AUTHOR_EMAILS",
    key: "gitAuthorEmails",
    description: "Comma-separated commit author emails that count as yours",
    secret: false,
    kind: "list",
  },
  {
    name: "CLAUDE_DIRS",
    key: "claudeDirs",
    description: "Comma-separated Claude Code config directories holding projects/*.jsonl",
    secret: false,
    kind: "list",
  },
  {
    name: "HOST_SLUG",
    key: "hostSlug",
    description: "Short name for this machine, stored with every Claude session",
    secret: false,
    kind: "string",
  },
  {
    name: "TZ",
    key: "tz",
    description: "IANA time zone used to place work on days (e.g. Europe/Berlin)",
    secret: false,
    kind: "string",
  },
  {
    name: "SINCE",
    key: "since",
    description: "Earliest date to sync, YYYY-MM-DD",
    secret: false,
    kind: "string",
  },
];

/** Raised when a command's required configuration is missing or malformed. */
export class ConfigError extends Error {
  readonly command: string;
  /** Names of the missing or invalid variables. */
  readonly variables: readonly string[];

  constructor(message: string, command: string, variables: readonly string[]) {
    super(message);
    this.name = "ConfigError";
    this.command = command;
    this.variables = variables;
  }
}

/** Expands a leading `~` or `~/`; `hooks/w5-common.sh` applies the same rule to TEMPAD_HOME. */
function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const name = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[name] = value;
  }
  return values;
}

/** Reads `<home>/.env`; an absent file is an empty map. */
export function readDotEnv(home: string): Record<string, string> {
  const envPath = join(home, ".env");
  return parseDotEnv(existsSync(envPath) ? readFileSync(envPath, "utf8") : "");
}

/**
 * `ANTHROPIC_API_KEY` for the `api` classifier backend: the real environment first, then
 * `<home>/.env`, like every other setting. No default; undefined when neither has one.
 */
export function anthropicApiKey(home: string): string | undefined {
  return process.env.ANTHROPIC_API_KEY || readDotEnv(home).ANTHROPIC_API_KEY || undefined;
}

/** `TEMPAD_HOME` (with `~` expanded), or `~/.tempad` when unset. A location, not a credential. */
export function tempadHome(): string {
  const user = homedir();
  const configured = process.env.TEMPAD_HOME;
  return configured ? expandHome(configured, user) : join(user, ".tempad");
}

/** A home is set up once `tempad setup` / `/tempad:setup` (or a hand-written `.env`) or a database exists in it. */
export function isConfigured(home: string): boolean {
  return existsSync(join(home, ".env")) || existsSync(join(home, "tempad.db"));
}

/** Where to send someone whose home is not configured: the skill inside Claude Code, the wizard in a terminal. */
export const SETUP_HINT = "run /tempad:setup in Claude Code, or `tempad setup` in a terminal";

export const NOT_SET_UP_MESSAGE = `tempad is not set up yet; ${SETUP_HINT}`;

/**
 * Names a cwd `.env` could inject. Bun loads `./.env` into `process.env` before any
 * code runs, and hooks run with the user's project as cwd, so these are the ones
 * a stranger's file could override.
 */
function guardedNames(): string[] {
  return [...ENV_VARS.map((variable) => variable.name), "TEMPAD_HOME", "ANTHROPIC_API_KEY"];
}

/** The files Bun auto-loads from the working directory, in its precedence order. */
function bunEnvFileNames(): string[] {
  const mode = process.env.NODE_ENV ?? "development";
  return [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`];
}

/**
 * Drops values Bun auto-loaded from the working directory's `.env*` files.
 *
 * The real fix is the `--no-env-file` flag in the CLI shebang (it also covers `bunx`),
 * which is detectable in `process.execArgv`. A direct `bun src/cli.ts` ignores the
 * shebang, so there each guarded variable whose current value is exactly what a cwd
 * file defines is deleted. The one false positive: a caller who explicitly exports the
 * same value a project `.env` happens to hold loses it, and the command then fails loudly
 * with a `ConfigError` rather than guessing.
 */
export function ignoreWorkingDirectoryEnvFiles(
  cwd: string = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): void {
  if (execArgv.includes("--no-env-file")) return;
  const guarded = new Set(guardedNames());
  for (const fileName of bunEnvFileNames()) {
    const path = join(cwd, fileName);
    if (!existsSync(path)) continue;
    for (const [name, value] of Object.entries(parseDotEnv(readFileSync(path, "utf8")))) {
      if (guarded.has(name) && environment[name] === value) delete environment[name];
    }
  }
}

function parseBoolean(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * Reads `process.env`, then `<home>/.env` (process.env wins), and validates only the
 * variables in `needs`. Every missing variable is named in one `ConfigError`. Required
 * values never have defaults.
 */
export function loadConfig<K extends ConfigKey>(
  command: string,
  needs: readonly K[],
): LoadedConfig<K> {
  const home = tempadHome();
  const fileValues = readDotEnv(home);
  const read = (name: string): string | undefined => process.env[name] ?? fileValues[name];

  const wanted = new Set<ConfigKey>(needs);
  const variables = ENV_VARS.filter((variable) => wanted.has(variable.key));

  const isMissing = (variable: EnvVar): boolean => {
    const raw = read(variable.name);
    if (raw === undefined || raw.trim().length === 0) return true;
    if (variable.kind === "list") return parseCommaList(raw).length === 0;
    return false;
  };

  const missing = variables
    .filter((variable) => !variable.optional && isMissing(variable))
    .map((variable) => variable.name);
  if (missing.length > 0) {
    throw new ConfigError(
      `${command} needs ${missing.join(", ")}; set ${missing.length === 1 ? "it" : "them"} in ${join(home, ".env")} or ${SETUP_HINT}`,
      command,
      missing,
    );
  }

  const loaded: Record<string, unknown> = { home };
  for (const variable of variables) {
    const raw = read(variable.name);
    if (variable.optional && raw === undefined) {
      loaded[variable.key] = undefined;
      continue;
    }
    const text = raw as string;
    if (variable.kind === "list") {
      const entries = parseCommaList(text);
      loaded[variable.key] =
        variable.key === "claudeDirs"
          ? entries.map((entry) => expandHome(entry, homedir()))
          : entries;
    } else if (variable.kind === "boolean") {
      const value = parseBoolean(text);
      if (value === undefined) {
        throw new ConfigError(
          `${command}: invalid ${variable.name}: expected "true" or "false", got "${text}"`,
          command,
          [variable.name],
        );
      }
      loaded[variable.key] = value;
    } else {
      loaded[variable.key] = text;
    }
  }

  return loaded as LoadedConfig<K>;
}

/**
 * Narrows a context's optional fields to the ones a handler reads. A dispatcher that
 * forgot to request them is a programming error, so this throws a plain `Error`.
 */
export function requireFields<K extends ConfigKey>(
  command: string,
  config: HomeConfig & Partial<Pick<Config, ConfigKey>>,
  keys: readonly K[],
): LoadedConfig<K> {
  const absent = keys.filter((key) => config[key] === undefined && key !== "ghToken");
  if (absent.length > 0) {
    throw new Error(`${command} was not given config field(s): ${absent.join(", ")}`);
  }
  return config as unknown as LoadedConfig<K>;
}
