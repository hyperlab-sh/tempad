#!/usr/bin/env -S bun --no-env-file
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import packageJson from "../package.json" with { type: "json" };
import { reresolveSessions as reresolveClaudeSessions } from "./collect/claude.ts";
import { collectors } from "./collect/index.ts";
import type { Collector, SyncSummary } from "./collect/types.ts";
import {
  type Config,
  ConfigError,
  type ConfigKey,
  ignoreWorkingDirectoryEnvFiles,
  isConfigured,
  type LoadedConfig,
  loadConfig,
  NOT_SET_UP_MESSAGE,
  tempadHome,
} from "./config/env.ts";
import { deriveOrgProject, registerProject } from "./config/project-register.ts";
import { loadRules, normalizePathForMatch } from "./config/rules.ts";
import { openDatabase } from "./db/database.ts";
import { setSyncState } from "./db/sync-state.ts";
import { runIntentCommand } from "./intent/cli.ts";
import { loadIntentConfig } from "./intent/config.ts";
import { ensureTables } from "./intent/projections";
import { reports } from "./report/index.ts";
import type { Report, ReportOptions } from "./report/types.ts";
import { runScryCommand } from "./scry/cli.ts";
import { runSetup } from "./setup/index.ts";
import { isSyncEnabled, SyncConfigError } from "./sync/config.ts";
import { forgetSync, formatForgetSummary, rejoinServer } from "./sync/forget.ts";
import { formatSyncSummary, runPushSync, SyncNotConfiguredError } from "./sync/run.ts";
import {
  planW5Command,
  runQuietCommand,
  runReviewCommand,
  runW5Command,
  runW5HookCommand,
  type W5Context,
} from "./w5/cli.ts";
import { userClaudeDirectory } from "./w5/hooks.ts";

const INTENT_COMMANDS = new Set([
  "hero",
  "party",
  "client",
  "saga",
  "quest",
  "stint",
  "trace",
  "impact",
  "answer",
  "rebuild",
]);

const USAGE_LINES: string[] = [
  "Usage:",
  "  tempad --help | -h | help | --version",
  "  tempad setup [--non-interactive] [--home <dir>] [--force] [--no-verify] [--<variable> <value> ...]   (create TEMPAD_HOME with .env and tempad.toml)",
  "  tempad sync [monday|github|claude] [--full] | --push | --pull | --push --pull | --forget [--force] | --rejoin <server-id>   (--rejoin: let sync use a server --forget left, accepting overwrites; --forget: after removing [sync], drop the sync triggers, tombstones and cursors for good; local only; refuses while changes never reached the server unless --force)",
  "  tempad report <daily|project|hourly|weekly> --from <date> --to <date> [--org X] [--project Y] [--out path] [--as-of <iso>] [--party <slug>] [--client <slug>] [--pr-date merged|authored]",
  '  tempad hero init "<name>"',
  '  tempad party add <slug> "<name>" [--joined YYYY-MM-DD] | leave <slug> --reason "..." | list',
  '  tempad client add <slug> "<name>"',
  '  tempad saga add --owner hero|party:<slug> "<title>" [--statement] | reword <id> "<title>" | replace <id> "<title>" --reason "..." | end <id> --reason ... | list [--all] [--as-of <iso>]',
  '  tempad quest add --owner ... [--serves <id>] "<title>" [--outcome] [--done] [--due] [--budget Nh|Nm] [--commitment] | confirm|merge|pause|resume|done|abandon|branch|return <id> | list [--all] [--unconfirmed] [--side] [--as-of <iso>]',
  '  tempad quest retract <id> --reason "..." [--force]   (undo a quest created by mistake; alias: delete)',
  '  tempad quest declare --session <id> (--quest <id> | --new "<title>" --outcome "<text>" | --done <quest>) [--plan "a; b; c"] ...',
  "  tempad stint list [--open] [--quest <id>]",
  "  tempad trace list [--since <iso>] [--stint <id>]",
  '  tempad impact set <ref> "<text>" [--theme <t>] | list [--project <p>] [--from <date> --to <date>] | import <file.json>',
  '  tempad answer <question-id> (--belongs | --quest <id|new:"title">) [--why "..."]',
  "  tempad rebuild [--until <iso>]",
  "  tempad w5 enqueue --session <id> [--forced]",
  "  tempad w5 context --session <id>",
  "  tempad w5 run [--detached]",
  "  tempad w5 hook install|uninstall [--scope user|project]",
  "  tempad w5 backfill [--days <n> | --from <iso>] [--model <name>] [--force]   (--from: classify sessions that ended at or after that time)",
  "  tempad w5 dedupe [--dry-run]",
  "  tempad w5 eval --from <date> --to <date> [--db <path>] [--declare <file>]",
  "  tempad quiet <2h|30m>",
  "  tempad review [--days <n>]",
  "  tempad scry [--json] [--days <n>] [--fast]   (read-only health check of the data: Health, Stats, Recommendations; exit 1 when a check fails; --fast skips quick_check and the projection replay)",
  "  tempad skill install [--scope user|project]",
  '  tempad project register <path> --name "<display>" [--org <org>] [--project <slug>] | list | reresolve <path>',
];

function printUsage(): void {
  for (const line of USAGE_LINES) console.error(line);
}

function printHelp(): void {
  for (const line of USAGE_LINES) console.log(line);
}

/**
 * Exit code 1 when `home` has neither `.env` nor `tempad.db`. Called before anything
 * that opens the database so an unconfigured machine never gets `~/.tempad/tempad.db`
 * created as a side effect.
 */
function assertConfigured(home: string): void {
  if (!isConfigured(home)) throw new NotSetUpError();
}

class NotSetUpError extends Error {
  constructor() {
    super(NOT_SET_UP_MESSAGE);
    this.name = "NotSetUpError";
  }
}

/**
 * Setup for a command that opens the database: the configured check first (so an
 * unconfigured home is never written to), then the command's own environment needs,
 * then the database.
 */
function prepareCommand<K extends ConfigKey>(
  label: string,
  needs: readonly K[],
): { config: LoadedConfig<K>; database: Database } {
  assertConfigured(tempadHome());
  const config = loadConfig(label, needs);
  // `sync_local` records the host for the sync triggers. Only commands that asked for
  // HOST_SLUG have it; for the rest the column stays NULL and the first push fills it.
  const hostSlug = (config as Partial<Pick<Config, "hostSlug">>).hostSlug;
  const database = openDatabase(
    join(config.home, "tempad.db"),
    hostSlug === undefined ? undefined : { hostSlug },
  );
  return { config, database };
}

export async function runSync(
  database: Database,
  config: LoadedConfig<ConfigKey>,
  selected: Collector[],
  full = false,
): Promise<{ summaries: SyncSummary[]; failed: boolean }> {
  const summaries: SyncSummary[] = [];
  let failed = false;

  for (const collector of selected) {
    const startedAt = new Date().toISOString();
    try {
      const summary = await collector.sync(database, config, { full });
      summaries.push(summary);
      setSyncState(database, collector.name, startedAt);
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      summaries.push({
        source: collector.name,
        inserted: 0,
        updated: 0,
        deleted: 0,
        warnings: [message],
      });
    }
  }

  return { summaries, failed };
}

/** `tempad sync --forget`: local only, so it needs no configuration beyond a set-up home. */
function runForgetCommand(syncEnabled: boolean, force: boolean): number {
  if (syncEnabled) {
    console.error(
      "sync: --forget refused: [sync] is still enabled in tempad.toml; remove the [sync] section first",
    );
    return 1;
  }
  const { database } = prepareCommand("tempad sync --forget", []);
  try {
    console.log(formatForgetSummary(forgetSync(database, undefined, force)));
  } catch (error) {
    console.error(`sync: forget failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    database.close();
  }
  return 0;
}

/** `tempad sync --rejoin <server-id>`: local only; lets the next sync use a server `--forget` left. */
function runRejoinCommand(serverId: string): number {
  const { database } = prepareCommand("tempad sync --rejoin", []);
  try {
    if (!rejoinServer(database, serverId)) {
      console.error(`sync: --rejoin: server ${serverId} was not forgotten; nothing to rejoin`);
      return 1;
    }
    console.log(`sync: rejoin allowed for server ${serverId}`);
  } finally {
    database.close();
  }
  return 0;
}

function parseSyncArguments(args: string[]) {
  return parseArgs({
    args,
    options: {
      full: { type: "boolean", default: false },
      push: { type: "boolean", default: false },
      pull: { type: "boolean", default: false },
      forget: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      rejoin: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
}

/** `node:util` parseArgs failures (unknown flag, flag missing its value) carry an `ERR_PARSE_ARGS_*` code. */
function isParseArgsError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const { code } = error as Error & { code?: unknown };
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

async function runSyncCommand(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseSyncArguments>;
  try {
    parsed = parseSyncArguments(args);
  } catch (error) {
    if (!isParseArgsError(error)) throw error;
    // One line naming the problem, then the usage, never the library's stack.
    // Node appends hints after the first sentence ("... place it at the end ..."); keep the sentence.
    const reason = (error.message.split("\n")[0] ?? "").split(". ")[0]?.replace(/\.$/, "");
    console.error(`sync: ${reason}.`);
    printUsage();
    return 2;
  }
  const { values, positionals } = parsed;
  const source = positionals[0];
  // --push/--pull run only those directions and skip the collectors, so they
  // take no source and no --full.
  const directional = values.push || values.pull;

  if (source !== undefined && !collectors.has(source as Collector["name"])) {
    printUsage();
    return 2;
  }
  if (directional && (source !== undefined || values.full)) {
    printUsage();
    return 2;
  }
  // --forget stands alone: it collects, pushes and pulls nothing.
  if (values.forget && (source !== undefined || values.full || directional)) {
    printUsage();
    return 2;
  }
  // --rejoin stands alone too, and --force only qualifies --forget.
  if (
    values.rejoin !== undefined &&
    (source !== undefined || values.full || directional || values.forget || values.force)
  ) {
    printUsage();
    return 2;
  }
  if (values.force && !values.forget) {
    printUsage();
    return 2;
  }

  const selected: Collector[] = directional
    ? []
    : source !== undefined
      ? [collectors.get(source as Collector["name"]) as Collector]
      : [...collectors.values()];

  // Only the selected collectors' variables are required, so `sync monday` works on a
  // machine that has never configured GitHub. `runSync` types the result as the full
  // config; each collector's own `LoadedConfig` is what it actually reads. Push sync
  // needs the host tag, and only when `[sync]` is enabled.
  let syncEnabled: boolean;
  try {
    syncEnabled = isSyncEnabled(tempadHome());
  } catch (error) {
    if (!(error instanceof SyncConfigError)) throw error;
    console.error(`sync: ${error.message}`);
    return 1;
  }
  if (values.forget) return runForgetCommand(syncEnabled, values.force);
  if (values.rejoin !== undefined) {
    if (values.rejoin.trim() === "") {
      console.error("sync: --rejoin needs a server id");
      return 1;
    }
    return runRejoinCommand(values.rejoin);
  }
  const needs: ConfigKey[] = [...new Set(selected.flatMap((collector) => collector.needs))];
  // Push sync needs the host tag and the server token, and only when [sync] is enabled:
  // without it the token is never read.
  if (syncEnabled) {
    for (const key of ["hostSlug", "syncToken"] as const) {
      if (!needs.includes(key)) needs.push(key);
    }
  }
  const label = source === undefined ? "tempad sync" : `tempad sync ${source}`;
  const { config, database } = prepareCommand(label, needs);

  let failed = false;
  if (!directional) {
    if (values.full) {
      const deleteSyncState = database.query("DELETE FROM sync_state WHERE source = ?");
      for (const collector of selected) {
        deleteSyncState.run(collector.name);
      }
    }

    const result = await runSync(database, config, selected, values.full);
    failed = result.failed;

    for (const summary of result.summaries) {
      const warnings = summary.warnings.length > 0 ? ` warnings=${summary.warnings.length}` : "";
      console.log(
        `${summary.source}: inserted=${summary.inserted} updated=${summary.updated} deleted=${summary.deleted}${warnings}`,
      );
    }
  }

  // Push sync, when [sync] is enabled: after the collectors (which keep
  // their results whatever happens here), or alone with --push/--pull.
  try {
    const summary = await runPushSync({
      database,
      home: config.home,
      hostSlug: config.hostSlug,
      syncToken: syncEnabled ? config.syncToken : undefined,
      push: directional ? values.push : true,
      pull: directional ? values.pull : true,
    });
    if (summary === null) {
      if (directional) throw new SyncNotConfiguredError();
    } else {
      console.log(formatSyncSummary(summary));
    }
  } catch (error) {
    // SyncRunError already reads `sync: push failed: <reason>`. The collector
    // summaries printed above stay, and the exit code is non-zero whatever they did.
    const message = error instanceof Error ? error.message : String(error);
    console.error(error instanceof SyncConfigError ? `sync: ${message}` : message);
    return 1;
  }

  return failed ? 1 : 0;
}

async function runReportCommand(args: string[]): Promise<number> {
  const kind = args[0];

  if (kind === undefined || !reports.has(kind as Report["kind"])) {
    printUsage();
    return 2;
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      org: { type: "string" },
      project: { type: "string" },
      out: { type: "string" },
      "as-of": { type: "string" },
      party: { type: "string" },
      client: { type: "string" },
      "pr-date": { type: "string" },
    },
    strict: true,
  });

  if (!values.from || !values.to) {
    printUsage();
    return 2;
  }

  if (
    values["pr-date"] !== undefined &&
    values["pr-date"] !== "merged" &&
    values["pr-date"] !== "authored"
  ) {
    printUsage();
    return 2;
  }

  const { config, database } = prepareCommand(`tempad report ${kind}`, ["tz"]);
  const report = reports.get(kind as Report["kind"]) as Report;

  const options: ReportOptions = {
    from: values.from,
    to: values.to,
    org: values.party ?? values.org,
    project: values.project,
    asOf: values["as-of"],
    client: values.client,
    prDate: values["pr-date"] as "merged" | "authored" | undefined,
  };

  const output = report.render(database, config, options);
  console.log(output);

  const outPath =
    values.out ?? join(config.home, "reports", `${kind}-${options.from}-${options.to}.md`);
  await Bun.write(outPath, output);

  return 0;
}

const SKILL_SOURCE_PATH = join(import.meta.dir, "..", "skills", "quest", "SKILL.md");

/**
 * Outside the plugin there is no `tempad:` namespace, so the legacy copy keeps the
 * descriptive directory and name `tempad-quest`; a bare `quest` is too generic there.
 */
const LEGACY_SKILL_NAME = "tempad-quest";

function skillDestinationFor(scope: string): string {
  if (scope === "project")
    return join(process.cwd(), ".claude", "skills", LEGACY_SKILL_NAME, "SKILL.md");
  try {
    return join(userClaudeDirectory(), "skills", LEGACY_SKILL_NAME, "SKILL.md");
  } catch {
    throw new Error(
      "HOME is not set; required for `tempad skill install --scope user` (or set CLAUDE_CONFIG_DIR)",
    );
  }
}

export function runSkillCommand(args: string[]): number {
  const [action, ...rest] = args;
  if (action !== "install") {
    printUsage();
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: { scope: { type: "string", default: "user" } },
    strict: true,
  });
  const scope = values.scope === "project" ? "project" : "user";
  const destination = skillDestinationFor(scope);
  mkdirSync(dirname(destination), { recursive: true });
  const source = readFileSync(SKILL_SOURCE_PATH, "utf8");
  writeFileSync(destination, source.replace(/^name: quest$/m, `name: ${LEGACY_SKILL_NAME}`));
  console.log(`installed ${LEGACY_SKILL_NAME} skill to ${destination}`);
  return 0;
}

export interface ProjectContext {
  database: Database;
  tomlPath: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  homedir: () => string;
}

export async function runProjectCommand(args: string[], context: ProjectContext): Promise<number> {
  const [action, ...rest] = args;
  const { database, tomlPath, stdout, stderr } = context;

  if (action === "register") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        name: { type: "string" },
        org: { type: "string" },
        project: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    const path = positionals[0];
    if (!path || !values.name) {
      printUsage();
      return 2;
    }

    try {
      registerProject(tomlPath, {
        path,
        name: values.name,
        org: values.org,
        project: values.project,
      });
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }

    const rules = loadRules(tomlPath);
    const absolutePath = normalizePathForMatch(path, context.homedir());
    const derived = deriveOrgProject(rules, absolutePath);
    const moved = reresolveClaudeSessions(database, rules, path, context.homedir());
    stdout(
      `registered "${path}" as ${values.org ?? derived.org}/${values.project ?? derived.project} (${values.name}); ${moved} session(s) reresolved`,
    );
    return 0;
  }

  if (action === "list") {
    const rules = loadRules(tomlPath);
    for (const rule of rules.projects) {
      if (rule.kind === "path") {
        stdout(`path\t${rule.absolutePath}\t${rule.org}\t${rule.project}\t${rule.name ?? ""}`);
      } else {
        stdout(
          `pattern\t${rule.urlPattern.pathname}\t${rule.org ?? ""}\t${rule.project ?? ""}\t${
            rule.name ?? ""
          }`,
        );
      }
    }
    return 0;
  }

  if (action === "reresolve") {
    const { positionals } = parseArgs({
      args: rest,
      options: {},
      strict: true,
      allowPositionals: true,
    });
    const path = positionals[0];
    if (!path) {
      printUsage();
      return 2;
    }
    const rules = loadRules(tomlPath);
    const moved = reresolveClaudeSessions(database, rules, path, context.homedir());
    stdout(`reresolved ${moved} session(s) under "${path}"`);
    return 0;
  }

  printUsage();
  return 2;
}

async function runProjectDispatch(rest: string[]): Promise<number> {
  const { config, database } = prepareCommand("tempad project", []);
  return runProjectCommand(rest, {
    database,
    tomlPath: join(config.home, "tempad.toml"),
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
    homedir,
  });
}

async function runIntentDispatch(command: string, rest: string[]): Promise<number> {
  const { config, database } = prepareCommand(`tempad ${command}`, []);
  const intentConfig = loadIntentConfig(join(config.home, "tempad.toml"));
  return runIntentCommand([command, ...rest], {
    database,
    config,
    intentConfig,
    stdout: (line: string) => console.log(line),
  });
}

async function runW5Dispatch(command: "w5" | "quiet" | "review", rest: string[]): Promise<number> {
  const plan = planW5Command(command, rest, { syncEnabled: () => isSyncEnabled(tempadHome()) });
  if (plan === null) {
    printUsage();
    return 2;
  }
  // Editing settings.json needs neither configuration nor a database; it is also the
  // migration step, so it must work on a machine tempad was never set up on.
  if (!plan.opensDatabase) return runW5HookCommand(rest.slice(1));

  // The hook-called commands never fail a session: on an unconfigured home they
  // exit 0 without output and without creating anything.
  if (plan.silentWhenUnconfigured && !isConfigured(tempadHome())) return 0;

  const { config, database } = prepareCommand(plan.label, plan.needs);
  // Projection tables are created lazily; the w5 commands read them, and a home that
  // `tempad setup` just set up has none yet. Intent commands do the same in runIntentCommand.
  ensureTables(database);
  const intentConfig = loadIntentConfig(join(config.home, "tempad.toml"));
  const context: W5Context = {
    database,
    config,
    intentConfig,
    stdout: (line: string) => console.log(line),
  };

  if (command === "w5") return runW5Command(rest, context);
  if (command === "quiet") return runQuietCommand(rest, context);
  if (command === "review") return runReviewCommand(rest, context);
  return 2;
}

const OTHER_COMMANDS = new Set([
  "setup",
  "init",
  "sync",
  "report",
  "w5",
  "quiet",
  "review",
  "scry",
  "skill",
  "project",
]);

/** `<command> --help` only applies to a command that exists; an unknown one is a usage error. */
function isKnownCommand(command: string | undefined): boolean {
  return command !== undefined && (INTENT_COMMANDS.has(command) || OTHER_COMMANDS.has(command));
}

async function dispatch(command: string | undefined, rest: string[]): Promise<number> {
  if (command === "--version" || command === "-v") {
    console.log(packageJson.version);
    return 0;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return 0;
  }
  if ((rest[0] === "--help" || rest[0] === "-h") && isKnownCommand(command)) {
    printHelp();
    return 0;
  }

  // `setup` needs no configuration and opens no database: it creates them.
  // `init` is its old name, still accepted but left out of --help.
  if (command === "setup" || command === "init") {
    return runSetup(rest);
  }

  if (command === "sync") {
    return runSyncCommand(rest);
  }
  if (command === "report") {
    return runReportCommand(rest);
  }
  if (command !== undefined && INTENT_COMMANDS.has(command)) {
    return runIntentDispatch(command, rest);
  }
  if (command === "w5" || command === "quiet" || command === "review") {
    return runW5Dispatch(command, rest);
  }
  if (command === "scry") {
    // Read-only: opens the database itself instead of through `prepareCommand`, which migrates and writes.
    assertConfigured(tempadHome());
    return runScryCommand(rest);
  }
  if (command === "skill") {
    return runSkillCommand(rest);
  }
  if (command === "project") {
    return runProjectDispatch(rest);
  }

  printUsage();
  return 2;
}

async function main(): Promise<number> {
  // The shebang passes --no-env-file; this covers `bun src/cli.ts`, which ignores it.
  ignoreWorkingDirectoryEnvFiles();
  const [command, ...rest] = process.argv.slice(2);
  try {
    return await dispatch(command, rest);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof NotSetUpError) {
      console.error(error.message);
      return 1;
    }
    // A malformed [sync] reached by a command that needs it (w5 backfill/eval).
    if (error instanceof SyncConfigError) {
      console.error(`sync: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
