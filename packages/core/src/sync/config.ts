import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Push-sync configuration (docs/specs/push-sync.md, "Configuration and
 * token"): the `[sync]` section of `tempad.toml`. The token is not read
 * here; it is the `syncToken` field of `loadConfig`, which a command asks
 * for only when `isSyncEnabled`, so an offline host never touches it.
 */
export interface SyncConfig {
  url: string;
  /** JWT for sqld. Never printed, logged or stored in `tempad.db`. */
  token: string;
  batchSize: number;
}

export const DEFAULT_SYNC_BATCH_SIZE = 500;

/**
 * A bad `[sync]` section or an unreadable `tempad.toml`. The CLI prints its
 * message as one line, never a stack trace. Messages never echo the url or
 * the token.
 */
export class SyncConfigError extends Error {
  override name = "SyncConfigError";
}

const SECURE_SCHEMES = new Set(["libsql:", "https:", "wss:"]);
const PLAIN_SCHEMES = new Set(["http:", "ws:"]);

function readSection(home: string): Record<string, unknown> | null {
  const tomlPath = join(home, "tempad.toml");
  if (!existsSync(tomlPath)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new SyncConfigError(
      `tempad.toml is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const section = parsed.sync;
  if (section === undefined) return null;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new SyncConfigError("tempad.toml: [sync] must be a table");
  }
  return section as Record<string, unknown>;
}

function sectionEnabled(section: Record<string, unknown>): boolean {
  const enabled = section.enabled ?? true;
  if (typeof enabled !== "boolean") {
    throw new SyncConfigError("tempad.toml: [sync].enabled must be true or false");
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

/**
 * Validates `[sync].url` and returns it rebuilt from the checked parse
 * (scheme, host, port, path), never the raw string. `@libsql/client` parses
 * the raw string with its own RFC 3986 regex, which does not treat `\` as
 * `/` the way WHATWG `URL` does: `http://127.0.0.1\@evil.com` passes a
 * loopback check on the WHATWG host yet connects to evil.com in plain
 * text. Handing the client only what was checked closes every such parser
 * differential; backslashes, whitespace and control characters (which
 * WHATWG silently strips or rewrites) are rejected outright as well.
 */
export function validateSyncUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SyncConfigError("tempad.toml: [sync].url is required when [sync] is enabled");
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\u0000-\u0020\u007f\\]/.test(value)) {
    throw new SyncConfigError(
      "tempad.toml: [sync].url must not contain backslashes, whitespace or control characters",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SyncConfigError("tempad.toml: [sync].url is not a valid URL");
  }
  // The client honours `?tls=0` (plain text under a libsql: scheme) and
  // `?authToken=` (a token in tempad.toml overriding TEMPAD_SYNC_TOKEN), and
  // userinfo would carry credentials too. None of them is ever needed, so the
  // url is scheme, host, port and path only. The value is not echoed back:
  // it may hold a credential.
  if (value.includes("?") || value.includes("#")) {
    throw new SyncConfigError(
      "tempad.toml: [sync].url must not have a query string or fragment (options like ?tls=0 or ?authToken= are not allowed)",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new SyncConfigError(
      "tempad.toml: [sync].url must not contain user info; the token comes from TEMPAD_SYNC_TOKEN",
    );
  }
  const rebuilt = `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  if (SECURE_SCHEMES.has(url.protocol)) return rebuilt;
  if (PLAIN_SCHEMES.has(url.protocol)) {
    if (isLoopback(url.hostname)) return rebuilt;
    throw new SyncConfigError(
      `tempad.toml: [sync].url uses plain ${url.protocol} on a non-loopback host; use libsql:, https: or wss: so the token is never sent unencrypted`,
    );
  }
  throw new SyncConfigError(
    `tempad.toml: [sync].url scheme ${url.protocol} is not supported; use libsql:, https: or wss:`,
  );
}

function validateBatchSize(value: unknown): number {
  if (value === undefined) return DEFAULT_SYNC_BATCH_SIZE;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new SyncConfigError("tempad.toml: [sync].batch_size must be a positive integer");
  }
  return value;
}

/**
 * Returns `null` when `[sync]` is absent or `enabled = false`. When enabled,
 * `url` is required (TLS schemes only, plain text on loopback only) and
 * `token` (`loadConfig`'s `syncToken`, from `TEMPAD_SYNC_TOKEN`) must be
 * non-blank; neither has a default.
 */
export function loadSyncConfig(home: string, token: string | undefined): SyncConfig | null {
  const section = readSection(home);
  if (section === null || !sectionEnabled(section)) return null;

  const url = validateSyncUrl(section.url);
  const batchSize = validateBatchSize(section.batch_size);

  if (token === undefined || token.trim() === "") {
    throw new SyncConfigError("TEMPAD_SYNC_TOKEN is required when [sync] is enabled");
  }

  return { url, token: token.trim(), batchSize };
}
