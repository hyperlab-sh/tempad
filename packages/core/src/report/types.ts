import type { Database } from "bun:sqlite";
import type { LoadedConfig } from "../config/env.ts";

export interface ReportOptions {
  from: string;
  to: string;
  org?: string;
  project?: string;
  asOf?: string;
  client?: string;
  /** Which date places a pull request in a day/week. Default `"merged"`. */
  prDate?: "merged" | "authored";
}

export interface Report {
  kind: "daily" | "project" | "hourly" | "weekly";
  render(database: Database, config: LoadedConfig<"tz">, options: ReportOptions): string;
}
