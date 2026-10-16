import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDotEnv } from "../config/env";

/**
 * Push-sync configuration (docs/specs/push-sync.md, "Configuration and
 * token"). Read only by the sync path, separately from `loadConfig`, so an
 * offline host never touches it beyond noticing the section is absent.
 */
export interface SyncConfig {
  url: string;
  /** JWT for sqld. Never printed, logged or stored in `tempad.db`. */
  token: string;
  batchSize: number;
}

export const DEFAULT_SYNC_BATCH_SIZE = 500;

const SECURE_SCHEMES = new Set(["libsql:", "https:", "wss:"]);
const PLAIN_SCHEMES = new Set(["http:", "ws:"]);

function readSection(home: string): Record<string, unknown> | null {
  const tomlPath = join(home, "tempad.toml");
  if (!existsSync(tomlPath)) return null;
  const parsed = Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as Record<string, unknown>;
  const section = parsed.sync;
  if (section === undefined) return null;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error("tempad.toml: [sync] must be a table");
  }
  return section as Record<string, unknown>;
}

function sectionEnabled(section: Record<string, unknown>): boolean {
  const enabled = section.enabled ?? true;
  if (typeof enabled !== "boolean") {
    throw new Error("tempad.toml: [sync].enabled must be true or false");
  }
  return enabled;
}

/**
 * Whether `[sync]` is present and enabled, without validating the url or
 * requiring the token: for callers (w5 backfill/eval) that only need to know
 * whether to stay on their own host's sessions.
 */
export function isSyncEnabled(home: string): boolean {
  const section = readSection(home);
  return section !== null && sectionEnabled(section);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

function validateUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("tempad.toml: [sync].url is required when [sync] is enabled");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`tempad.toml: [sync].url is not a valid URL: ${value}`);
  }
  if (SECURE_SCHEMES.has(url.protocol)) return value;
  if (PLAIN_SCHEMES.has(url.protocol)) {
    if (isLoopback(url.hostname)) return value;
    throw new Error(
      `tempad.toml: [sync].url uses plain ${url.protocol} on a non-loopback host; use libsql:, https: or wss: so the token is never sent unencrypted`,
    );
  }
  throw new Error(
    `tempad.toml: [sync].url scheme ${url.protocol} is not supported; use libsql:, https: or wss:`,
  );
}

function validateBatchSize(value: unknown): number {
  if (value === undefined) return DEFAULT_SYNC_BATCH_SIZE;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("tempad.toml: [sync].batch_size must be a positive integer");
  }
  return value;
}

/**
 * Returns `null` when `[sync]` is absent or `enabled = false`. When enabled,
 * `url` is required (TLS schemes only, plain text on loopback only) and
 * `TEMPAD_SYNC_TOKEN` is required from `env`, else `home/.env`; neither has a
 * default.
 */
export function loadSyncConfig(
  home: string,
  env: Record<string, string | undefined>,
): SyncConfig | null {
  const section = readSection(home);
  if (section === null || !sectionEnabled(section)) return null;

  const url = validateUrl(section.url);
  const batchSize = validateBatchSize(section.batch_size);

  let token = env.TEMPAD_SYNC_TOKEN;
  if (token === undefined || token.trim() === "") {
    const envPath = join(home, ".env");
    token = existsSync(envPath)
      ? parseDotEnv(readFileSync(envPath, "utf8")).TEMPAD_SYNC_TOKEN
      : undefined;
  }
  if (token === undefined || token.trim() === "") {
    throw new Error("TEMPAD_SYNC_TOKEN is required when [sync] is enabled");
  }

  return { url, token: token.trim(), batchSize };
}
