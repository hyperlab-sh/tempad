import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, tempadHome } from "../config/env";
import { loadRules } from "../config/rules";
import { defaultIntentConfig, loadIntentConfig } from "../intent/config";
import { probeSchedule, type ScheduleProbe } from "../schedule/index";
import { isSyncEnabled, loadSyncConfig, SyncConfigError } from "../sync/config";
import { usageText } from "../usage";
import { scry } from "./collect";
import { formatReport } from "./format";
import type { Check, Recommendation, ScryReport } from "./types";

export const SCRY_USAGE = `usage: ${usageText("scry")}`;

/** About ten years: far enough back for any real history, and `now - days` stays a valid date. */
export const MAX_DAYS = 3650;

/** A failure of SQLite itself (not a file, not a database, locked, corrupt), as opposed to a bug in scry. */
function isSqliteError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "SQLiteError" || /^SQLITE_/.test(String((error as { code?: unknown }).code)))
  );
}

export interface ScryCommandOptions {
  now?: Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Stands in for the filesystem probe of the scheduler (`null`: no supported scheduler). */
  schedule?: ScheduleProbe | null;
}

function failure(id: string, title: string, summary: string): Check {
  return { id, title, status: "fail", summary, details: [] };
}

/** The report for a home with no readable database: the checks that failed, the one command that may fix it, no stats. */
function reportWithoutDatabase(
  home: string,
  windowDays: number,
  now: Date,
  checks: Check[],
  recommendations: Recommendation[],
): ScryReport {
  return {
    generatedAt: now.toISOString(),
    home,
    ok: false,
    windowDays,
    checks,
    stats: null,
    recommendations,
    notes: ["The other checks were skipped: they need the database."],
    durationMs: 0,
  };
}

/**
 * `tempad scry`. Opens `tempad.db` read-only on its own connection: unlike
 * every other command it does not go through `openDatabase`, which applies
 * migrations, backfills event uids, repairs the sync triggers and writes the
 * host slug. Never touches the network: `[sync]` is read for its on/off
 * state only, and `@libsql/client` is never imported.
 *
 * Exit 0 when no check failed (warnings and recommendations do not fail), 1
 * when one did, 2 on a usage error. The caller has already checked that the
 * home is set up.
 */
export function runScryCommand(args: string[], options: ScryCommandOptions = {}): number {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const now = options.now ?? new Date();

  let values: { json?: boolean; fast?: boolean; days?: string };
  try {
    values = parseArgs({
      args,
      options: {
        json: { type: "boolean", default: false },
        fast: { type: "boolean", default: false },
        days: { type: "string" },
      },
      strict: true,
    }).values;
  } catch (error) {
    stderr(`scry: ${error instanceof Error ? error.message : String(error)}`);
    stderr(SCRY_USAGE);
    return 2;
  }
  if (
    values.days !== undefined &&
    !(/^[1-9]\d*$/.test(values.days) && Number.parseInt(values.days, 10) <= MAX_DAYS)
  ) {
    stderr(`scry: --days needs a whole number from 1 to ${MAX_DAYS}, got "${values.days}"`);
    stderr(SCRY_USAGE);
    return 2;
  }

  const home = tempadHome();
  const priorChecks: Check[] = [];

  const warnings: string[] = [];
  let renamedKeys = 0;
  let wrongTypes = 0;
  let intentConfig = defaultIntentConfig();
  const tomlPath = join(home, "tempad.toml");
  try {
    intentConfig = loadIntentConfig(tomlPath, (message, kind) => {
      warnings.push(message);
      if (kind === "renamed-key") renamedKeys += 1;
      else wrongTypes += 1;
    });
    // The `[[projects]]` rules are read by the collectors, not by `loadIntentConfig`; a bad one
    // there throws (a failed check) or warns (a wrong-typed `name`, counted as a wrong type).
    loadRules(tomlPath, (message) => {
      warnings.push(message);
      wrongTypes += 1;
    });
  } catch (error) {
    priorChecks.push(
      failure(
        "config",
        "Config",
        `tempad.toml cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  let syncEnabled = false;
  try {
    syncEnabled = isSyncEnabled(home);
    // `isSyncEnabled` only reads the on/off flag; this also checks the url and batch size. The
    // token argument is a placeholder: scry never connects, so it never reads the real one.
    if (syncEnabled) loadSyncConfig(home, "not-read");
  } catch (error) {
    if (!(error instanceof SyncConfigError)) throw error;
    priorChecks.push(failure("config-sync", "Config [sync]", error.message));
  }
  if (priorChecks.length === 0) {
    priorChecks.push({
      id: "config",
      title: "Config",
      status: warnings.length > 0 ? "warn" : "ok",
      summary:
        warnings.length > 0
          ? [
              wrongTypes > 0 ? `${wrongTypes} setting(s) of the wrong type (default used)` : null,
              renamedKeys > 0 ? `${renamedKeys} deprecated setting(s)` : null,
            ]
              .filter((part) => part !== null)
              .join(", ")
              .concat(" in tempad.toml")
          : "tempad.toml reads cleanly",
      details: warnings,
    });
  }

  // Own-host filtering needs the host slug, and only with sync on (the same rule as `w5 backfill`).
  const hostSlug = syncEnabled ? loadConfig("tempad scry", ["hostSlug"]).hostSlug : undefined;
  const windowDays =
    values.days !== undefined ? Number.parseInt(values.days, 10) : intentConfig.w5.backfillDays;

  const databasePath = join(home, "tempad.db");
  let report: ScryReport;
  if (!existsSync(databasePath)) {
    report = reportWithoutDatabase(
      home,
      windowDays,
      now,
      [...priorChecks, failure("database", "Database", `${databasePath} does not exist`)],
      [
        {
          id: "first-sync",
          command: "tempad sync",
          reason: "creates the database and collects the first data",
        },
      ],
    );
  } else {
    let database: Database | null = null;
    try {
      database = new Database(databasePath, { readonly: true });
      database.exec("PRAGMA busy_timeout = 5000");
      report = scry({
        database,
        home,
        databasePath,
        now,
        w5: intentConfig.w5,
        windowDays,
        syncEnabled,
        hostSlug,
        fast: values.fast === true,
        schedule: options.schedule === undefined ? probeSchedule() : options.schedule,
        priorChecks,
        sizeBytes: statSync(databasePath).size,
      });
    } catch (error) {
      // Only SQLite's own failures mean "cannot read the database"; anything else is a bug and surfaces.
      if (!isSqliteError(error)) throw error;
      report = reportWithoutDatabase(
        home,
        windowDays,
        now,
        [
          ...priorChecks,
          failure(
            "database",
            "Database",
            `cannot read ${databasePath}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ],
        [],
      );
    } finally {
      database?.close();
    }
  }

  stdout(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}
