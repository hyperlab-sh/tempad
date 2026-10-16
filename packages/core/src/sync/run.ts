/**
 * The CLI's entry into push sync: config, then the network module by dynamic
 * `import()`, then the engine. With sync disabled this returns `null` having
 * loaded nothing beyond `config.ts`.
 */
import type { Database } from "bun:sqlite";
import { loadSyncConfig } from "./config";
import { runSyncEngine, type SyncRemote, type SyncRunSummary } from "./engine";

export interface PushSyncRequest {
  database: Database;
  home: string;
  hostSlug: string;
  env: Record<string, string | undefined>;
  push: boolean;
  pull: boolean;
}

export function formatSyncSummary(summary: SyncRunSummary): string {
  const { pushed, pulled } = summary;
  return `sync: pushed events=${pushed.events} rows=${pushed.rows} tombstones=${pushed.tombstones} pulled events=${pulled.events} rows=${pulled.rows} tombstones=${pulled.tombstones} rebuilt=${summary.rebuilt ? "yes" : "no"}`;
}

/**
 * Error text safe to print: the client's message only (never its cause,
 * request or headers), with the token scrubbed should a server ever echo it.
 */
export function safeErrorMessage(error: unknown, token: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  // A token short enough to occur in ordinary words is not worth scrubbing
  // (and would mangle the message); real JWTs are hundreds of characters.
  return token && token.length >= 16 ? message.split(token).join("<redacted>") : message;
}

export class SyncNotConfiguredError extends Error {
  constructor() {
    super("sync is not configured: add [sync] to tempad.toml");
  }
}

/**
 * Runs one push/pull against the configured remote. Returns `null` when sync
 * is disabled. Throws `Error`s whose messages are already safe to print.
 */
export async function runPushSync(
  request: PushSyncRequest,
  openRemote?: (config: NonNullable<ReturnType<typeof loadSyncConfig>>) => SyncRemote,
): Promise<SyncRunSummary | null> {
  const config = loadSyncConfig(request.home, request.env);
  if (config === null) return null;
  const open = openRemote ?? (await import("./remote")).openRemote;
  let remote: SyncRemote | undefined;
  try {
    remote = open(config);
    return await runSyncEngine(request.database, remote, {
      hostSlug: request.hostSlug,
      batchSize: config.batchSize,
      push: request.push,
      pull: request.pull,
    });
  } catch (error) {
    throw new Error(safeErrorMessage(error, config.token));
  } finally {
    remote?.close();
  }
}
