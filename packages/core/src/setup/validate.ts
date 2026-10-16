import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EnvVar } from "../config/env.ts";

/**
 * - `ok`: the check passed.
 * - `warning`: worth knowing, never blocks (e.g. `MONDAY_USER` differs from the token's user).
 * - `unverified`: could not be checked (network down, timeout); the user may accept it
 *   interactively, a non-interactive run treats it as an error.
 * - `error`: definitely wrong.
 */
export type FindingLevel = "ok" | "warning" | "unverified" | "error";

export interface Finding {
  level: FindingLevel;
  /** Variable the finding is about. */
  variable: string;
  message: string;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

/** Runs a command with a time limit; rejects when the program cannot be started. */
export type SpawnFunction = (
  command: string[],
  options: { timeoutMs: number },
) => Promise<SpawnResult>;

export interface ValidationDeps {
  fetch: typeof fetch;
  spawn: SpawnFunction;
  /** Per-check limit; a check that exceeds it is `unverified`. */
  timeoutMs: number;
  /** Used to expand `~` in `CLAUDE_DIRS`. */
  homedir: string;
}

const MONDAY_ENDPOINT = "https://api.monday.com/v2";
const MONDAY_API_VERSION = "2026-07";
const GITHUB_USER_ENDPOINT = "https://api.github.com/user";

/** Splits a comma-separated value the way `loadConfig` does. */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone.trim().length > 0;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` naming a real calendar day. */
export function isValidSince(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Syntax check of one value; returns the problem, or undefined when it is fine. Pure and
 * always applied (even with `--no-verify`): a value `loadConfig` would reject must never
 * be written.
 */
export function describeInvalidValue(variable: EnvVar, value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return variable.optional ? undefined : "a value is required";
  if (/[\r\n]/.test(value)) return "must be a single line";
  if (variable.kind === "boolean" && trimmed !== "true" && trimmed !== "false") {
    return 'must be "true" or "false"';
  }
  if (variable.kind === "list" && splitList(trimmed).length === 0) {
    return "needs at least one entry";
  }
  if (variable.name === "TZ" && !isValidTimeZone(trimmed)) {
    return `"${trimmed}" is not an IANA time zone (e.g. Europe/Berlin)`;
  }
  if (variable.name === "SINCE" && !isValidSince(trimmed)) {
    return `"${trimmed}" is not a date; use YYYY-MM-DD`;
  }
  return undefined;
}

function unreachable(what: string, error: unknown): string {
  const timedOut =
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return timedOut ? `${what} did not answer in time` : `could not reach ${what}`;
}

async function checkMonday(
  values: Readonly<Record<string, string>>,
  deps: ValidationDeps,
): Promise<Finding[]> {
  const variable = "MONDAY_API_TOKEN";
  try {
    const response = await deps.fetch(MONDAY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: values.MONDAY_API_TOKEN ?? "",
        "API-Version": MONDAY_API_VERSION,
      },
      body: JSON.stringify({ query: "{ me { id name } }" }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return [
        {
          level: "error",
          variable,
          message: `Monday rejected the token (HTTP ${response.status})`,
        },
      ];
    }
    if (!response.ok) {
      return [
        {
          level: "unverified",
          variable,
          message: `Monday answered HTTP ${response.status}; token not verified`,
        },
      ];
    }
    const body = (await response.json()) as {
      data?: { me?: { id?: string | number; name?: string } };
      errors?: { message?: string }[];
    };
    const me = body.data?.me;
    if (!me) {
      const reason = body.errors?.[0]?.message ?? "no user in the response";
      return [{ level: "error", variable, message: `Monday did not accept the token: ${reason}` }];
    }
    const findings: Finding[] = [
      { level: "ok", variable, message: `Monday: authenticated as ${me.name ?? "unknown"}` },
    ];
    const configured = (values.MONDAY_USER ?? "").trim().toLowerCase();
    if (configured !== "") {
      const matches =
        configured === String(me.id ?? "").toLowerCase() ||
        configured === (me.name ?? "").trim().toLowerCase();
      if (!matches) {
        findings.push({
          level: "warning",
          variable: "MONDAY_USER",
          message: `MONDAY_USER "${values.MONDAY_USER}" is neither the token's user id (${me.id}) nor its name ("${me.name}")`,
        });
      }
    }
    return findings;
  } catch (error) {
    return [
      {
        level: "unverified",
        variable,
        message: `Monday: ${unreachable("api.monday.com", error)}; token not verified`,
      },
    ];
  }
}

async function checkGitHub(
  values: Readonly<Record<string, string>>,
  deps: ValidationDeps,
): Promise<Finding[]> {
  const token = values.GH_TOKEN;
  if (token !== undefined && token !== "") {
    const variable = "GH_TOKEN";
    try {
      const response = await deps.fetch(GITHUB_USER_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "tempad-setup",
        },
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      if (response.status === 401 || response.status === 403) {
        return [
          {
            level: "error",
            variable,
            message: `GitHub rejected GH_TOKEN (HTTP ${response.status})`,
          },
        ];
      }
      if (!response.ok) {
        return [
          {
            level: "unverified",
            variable,
            message: `GitHub answered HTTP ${response.status}; token not verified`,
          },
        ];
      }
      const body = (await response.json()) as { login?: string };
      const findings: Finding[] = [
        { level: "ok", variable, message: `GitHub: token belongs to ${body.login ?? "unknown"}` },
      ];
      const configured = (values.GH_USER ?? "").trim();
      if (
        configured !== "" &&
        body.login &&
        configured.toLowerCase() !== body.login.toLowerCase()
      ) {
        findings.push({
          level: "warning",
          variable: "GH_USER",
          message: `GH_USER "${configured}" differs from the token's login "${body.login}"`,
        });
      }
      return findings;
    } catch (error) {
      return [
        {
          level: "unverified",
          variable,
          message: `GitHub: ${unreachable("api.github.com", error)}; token not verified`,
        },
      ];
    }
  }

  const variable = "GH_TOKEN";
  try {
    const result = await deps.spawn(["gh", "auth", "status"], { timeoutMs: deps.timeoutMs });
    if (result.timedOut) {
      return [
        {
          level: "unverified",
          variable,
          message: "GitHub: `gh auth status` did not answer in time",
        },
      ];
    }
    if (result.exitCode !== 0) {
      return [
        {
          level: "error",
          variable,
          message: "GitHub: GH_TOKEN is not set and gh is not logged in (run: gh auth login)",
        },
      ];
    }
    return [{ level: "ok", variable, message: "GitHub: using the logged-in gh credentials" }];
  } catch {
    return [
      {
        level: "error",
        variable,
        message: "GitHub: GH_TOKEN is not set and gh is not installed; set a token or install gh",
      },
    ];
  }
}

function checkClaudeDirs(
  values: Readonly<Record<string, string>>,
  deps: ValidationDeps,
): Finding[] {
  const variable = "CLAUDE_DIRS";
  const findings: Finding[] = [];
  for (const entry of splitList(values.CLAUDE_DIRS ?? "")) {
    const directory = entry.startsWith("~") ? join(deps.homedir, entry.slice(1)) : entry;
    const isDirectory = existsSync(directory) && statSync(directory).isDirectory();
    if (!isDirectory) {
      findings.push({ level: "error", variable, message: `${entry} is not an existing directory` });
    } else if (!existsSync(join(directory, "projects"))) {
      findings.push({
        level: "warning",
        variable,
        message: `${entry} has no projects/ folder; CLAUDE_DIRS wants the Claude config directory (e.g. ~/.claude), not projects/ itself`,
      });
    } else {
      findings.push({ level: "ok", variable, message: `${entry} exists` });
    }
  }
  return findings;
}

/** Syntax findings for every variable; only problems are reported (no `ok` entries). */
export function validateFormat(
  variables: readonly EnvVar[],
  values: Readonly<Record<string, string>>,
): Finding[] {
  const findings: Finding[] = [];
  for (const variable of variables) {
    const problem = describeInvalidValue(variable, values[variable.name] ?? "");
    if (problem)
      findings.push({
        level: "error",
        variable: variable.name,
        message: `${variable.name}: ${problem}`,
      });
  }
  return findings;
}

/**
 * The checks that touch the network, `gh` or the file system: Monday token, GitHub
 * credentials, `CLAUDE_DIRS` existence. Each is time-boxed by `deps.timeoutMs`. Messages
 * never contain a token.
 */
export async function validateExternal(
  values: Readonly<Record<string, string>>,
  deps: ValidationDeps,
): Promise<Finding[]> {
  const [monday, github] = await Promise.all([
    checkMonday(values, deps),
    checkGitHub(values, deps),
  ]);
  return [...monday, ...github, ...checkClaudeDirs(values, deps)];
}
