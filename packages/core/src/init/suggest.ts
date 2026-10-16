import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SpawnFunction } from "./validate.ts";

export interface SuggestionDeps {
  spawn: SpawnFunction;
  homedir: string;
  env: Readonly<Record<string, string | undefined>>;
  hostname: () => string;
  timeZone: () => string;
  /** Per-command limit; a command that exceeds it is ignored. */
  timeoutMs: number;
}

/** `my-laptop.local` -> `my-laptop`; anything outside `[a-z0-9-]` becomes a hyphen. */
export function shortHostname(hostname: string): string {
  const first = hostname.split(".")[0] ?? "";
  return first
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function runQuietly(
  spawn: SpawnFunction,
  command: string[],
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const result = await spawn(command, { timeoutMs });
    if (result.timedOut || result.exitCode !== 0) return undefined;
    const output = result.stdout.trim();
    return output === "" ? undefined : output;
  } catch {
    return undefined;
  }
}

/**
 * Values worth offering as prompt text, keyed by variable name. Nothing here becomes a
 * runtime default: the user confirms each one, and every failure (no git, no gh, not
 * logged in, slow network) just means no suggestion.
 */
export async function detectSuggestions(deps: SuggestionDeps): Promise<Record<string, string>> {
  const suggestions: Record<string, string> = {};

  const zone = deps.timeZone();
  if (zone) suggestions.TZ = zone;

  const host = shortHostname(deps.hostname());
  if (host) suggestions.HOST_SLUG = host;

  // CLAUDE_DIRS wants the config directory that holds projects/ (the collector globs
  // `<dir>/projects/*/*.jsonl`), so suggest `~/.claude`, never `~/.claude/projects`.
  const configured = deps.env.CLAUDE_CONFIG_DIR;
  if (configured && existsSync(join(configured, "projects"))) {
    suggestions.CLAUDE_DIRS = configured;
  } else if (existsSync(join(deps.homedir, ".claude", "projects"))) {
    suggestions.CLAUDE_DIRS = "~/.claude";
  }

  const [email, login] = await Promise.all([
    runQuietly(deps.spawn, ["git", "config", "--global", "user.email"], deps.timeoutMs),
    runQuietly(deps.spawn, ["gh", "api", "user", "--jq", ".login"], deps.timeoutMs),
  ]);
  if (email) suggestions.GIT_AUTHOR_EMAILS = email;
  if (login) suggestions.GH_USER = login;

  return suggestions;
}
