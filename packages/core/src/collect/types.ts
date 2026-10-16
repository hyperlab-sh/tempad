import type { Database } from "bun:sqlite";
import type { ConfigKey, LoadedConfig } from "../config/env.ts";

export interface SyncSummary {
  source: string;
  inserted: number;
  updated: number;
  deleted: number;
  warnings: string[];
}

export interface SyncOptions {
  since?: string;
  fetch?: typeof fetch;
  full?: boolean;
}

/**
 * A collector declares the `Config` fields it reads in `needs`; `sync` receives
 * exactly those, so reading anything else is a type error and `tempad sync <source>`
 * asks the environment for nothing more.
 */
export interface Collector<K extends ConfigKey = ConfigKey> {
  name: "monday" | "github" | "claude";
  needs: readonly K[];
  sync(database: Database, config: LoadedConfig<K>, options: SyncOptions): Promise<SyncSummary>;
}
