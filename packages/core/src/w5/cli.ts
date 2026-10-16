import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { childEnvironment } from "../config/child-env";
import {
  anthropicApiKey,
  type Config,
  type ConfigKey,
  type HomeConfig,
  requireFields,
} from "../config/env";
import type { IntentConfig } from "../intent/config";
import { activeDeclaredQuests } from "../intent/declarations";
import { isSyncEnabled } from "../sync/config";
import { backfill } from "./backfill";
import { AnthropicClassifier, type Classifier } from "./classifier";
import { ClaudeCliClassifier } from "./classifier-cli";
import { dedupe } from "./dedupe";
import { InvalidDeclareFileError, InvalidEvalRangeError, runEval, validateEvalRange } from "./eval";
import {
  buildAdditionalContext,
  buildBelongsHandback,
  buildDeclarationLine,
  buildDeclareHandback,
  hasTempadHooks,
  hasUnstableInstall,
  installHooks,
  PLUGIN_RECOMMENDATION_MESSAGE,
  SettingsParseError,
  settingsPathFor,
  UNSTABLE_INSTALL_MESSAGE,
  uninstallHooks,
} from "./hooks";
import { enqueueJob } from "./jobs";
import type { QuestionRow } from "./questions";
import { drain } from "./runner";

export interface SpawnOptions {
  cmd: string[];
  detached: boolean;
  stdio: ["ignore", number, number];
  env: Record<string, string | undefined>;
}

export type SpawnFn = (options: SpawnOptions) => void;

/**
 * What a w5 handler is handed: the home, plus whichever of these `planW5Command`
 * said the subcommand needs. A handler that reads one goes through `requireFields`.
 */
export type W5RuntimeConfig = HomeConfig & Partial<Pick<Config, "claudeDirs" | "hostSlug" | "tz">>;

export interface W5Context {
  database: Database;
  config: W5RuntimeConfig;
  intentConfig: IntentConfig;
  stdout: (line: string) => void;
  spawn?: SpawnFn;
}

const defaultSpawn: SpawnFn = (options) => {
  Bun.spawn({
    cmd: options.cmd,
    detached: options.detached,
    stdio: options.stdio,
    env: options.env,
  });
};

const CLI_PATH = join(import.meta.dir, "..", "cli.ts");

function logPath(config: HomeConfig): string {
  return join(config.home, "logs", "w5.log");
}

function log(config: HomeConfig, line: string): void {
  const path = logPath(config);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
}

function buildClassifier(
  config: HomeConfig,
  intentConfig: IntentConfig,
  model?: string,
): Classifier {
  const resolvedModel = model ?? intentConfig.w5.model;

  const timeoutMs = intentConfig.w5.timeoutSeconds * 1000;

  if (intentConfig.w5.backend === "claude-cli") {
    return new ClaudeCliClassifier({
      model: resolvedModel,
      command: intentConfig.w5.claudeCommand,
      cwd: config.home,
      timeoutMs,
    });
  }

  const apiKey = anthropicApiKey(config.home);
  if (!apiKey) {
    return {
      classify() {
        return Promise.reject(new Error("ANTHROPIC_API_KEY not set"));
      },
    };
  }
  return new AnthropicClassifier({ apiKey, model: resolvedModel, timeoutMs });
}

function lockPathFor(config: HomeConfig): string {
  return join(config.home, "w5.lock");
}

function spawnDetachedRun(context: W5Context): void {
  const spawn = context.spawn ?? defaultSpawn;
  const path = logPath(context.config);
  mkdirSync(dirname(path), { recursive: true });
  const logFd = openSync(path, "a");

  spawn({
    // --no-env-file: the detached run inherits the hook's cwd, a user's project, and
    // Bun would load that project's .env over TEMPAD_HOME/.env.
    cmd: [process.execPath, "--no-env-file", CLI_PATH, "w5", "run"],
    detached: true,
    stdio: ["ignore", logFd, logFd],
    // `w5 run` classifies; it never syncs or calls Monday/GitHub, so it gets no tempad secret.
    env: { ...childEnvironment(), TEMPAD_HOME: context.config.home },
  });
}

function runEnqueue(args: string[], context: W5Context): number {
  const { values } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      forced: { type: "boolean", default: false },
      kind: { type: "string" },
    },
    strict: true,
  });

  if (!values.session) return 0;

  try {
    enqueueJob(context.database, {
      sessionId: values.session,
      forced: values.forced === true,
      throttleMinutes: context.intentConfig.w5.throttleMinutes,
      kind: values.kind,
    });

    const lockPath = lockPathFor(context.config);
    clearStaleLock(lockPath, (line) => log(context.config, line));

    if (!existsSync(lockPath)) {
      spawnDetachedRun(context);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(context.config, `enqueue failed: ${message}`);
  }
  return 0;
}

function runContext(args: string[], context: W5Context): number {
  const { values } = parseArgs({
    args,
    options: { session: { type: "string" } },
    strict: true,
  });
  if (!values.session) return 0;

  const active = activeDeclaredQuests(context.database, {
    sessionId: values.session,
    at: new Date().toISOString(),
  });
  const declarationLine = buildDeclarationLine(
    active.map((quest) => ({ title: quest.title, alias: quest.alias })),
    values.session,
    process.env.TEMPAD_HOOK_SOURCE,
  );

  const rows = context.database
    .query(
      `SELECT id, trace_id as traceId, session_id as sessionId, kind, state, turns_watched as turnsWatched,
              turns_at_ask as turnsAtAsk, is_switch as isSwitch
         FROM questions WHERE session_id = ? AND state = 'asked' ORDER BY asked_at DESC`,
    )
    .all(values.session) as (Omit<QuestionRow, "isSwitch"> & { isSwitch: number })[];

  const questions: QuestionRow[] = rows.map((row) => ({ ...row, isSwitch: row.isSwitch === 1 }));
  const guesses = new Map(
    (
      context.database
        .query("SELECT id, guess FROM questions WHERE session_id = ? AND state = 'asked'")
        .all(values.session) as { id: string; guess: string | null }[]
    ).map((row) => [row.id, row.guess]),
  );
  const text = buildAdditionalContext(questions, {
    activeQuests: active.map((quest) => ({ title: quest.title, alias: quest.alias })),
    sessionId: values.session,
    guessFor: (questionId) => guesses.get(questionId) ?? null,
  });
  const parts = [declarationLine, text].filter((part) => part.length > 0);
  if (parts.length > 0) context.stdout(parts.join("\n"));
  return 0;
}

const STALE_LOCK_MINUTES = 30;

function clearStaleLock(lockPath: string, log: (line: string) => void): void {
  if (!existsSync(lockPath)) return;
  const ageMinutes = (Date.now() - statSync(lockPath).mtimeMs) / 60_000;
  if (ageMinutes >= STALE_LOCK_MINUTES) {
    log(`w5.lock is stale (${Math.round(ageMinutes)}m old), removing`);
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone
    }
  }
}

async function runRun(args: string[], context: W5Context): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { detached: { type: "boolean", default: false } },
    strict: true,
  });

  const lockPath = lockPathFor(context.config);
  clearStaleLock(lockPath, (line) => log(context.config, line));

  if (existsSync(lockPath)) {
    return 0;
  }
  mkdirSync(dirname(lockPath), { recursive: true });

  if (values.detached) {
    spawnDetachedRun(context);
    return 0;
  }

  try {
    await Bun.write(lockPath, String(process.pid));
    const classifier = buildClassifier(context.config, context.intentConfig);
    const count = await drain(
      context.database,
      requireFields("tempad w5 run", context.config, W5_RUN_NEEDS),
      context.intentConfig.w5,
      classifier,
      {
        log: (line) => log(context.config, line),
      },
    );
    context.stdout(`w5: ran ${count} job(s)`);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // lock already gone
    }
  }
  return 0;
}

function runQuiet(args: string[], context: W5Context): number {
  const duration = args[0];
  if (!duration) return 2;

  const match = duration.match(/^(\d+)([hm])$/);
  if (!match) return 2;
  const amount = Number.parseInt(match[1] as string, 10);
  const unit = match[2];
  const minutes = unit === "h" ? amount * 60 : amount;
  const until = new Date(Date.now() + minutes * 60_000).toISOString();

  context.database.query("INSERT INTO w5_quiet (until) VALUES (?)").run(until);
  context.stdout(`quiet until ${until}`);
  return 0;
}

const REVIEW_DEFAULT_DAYS = 7;

const REVIEW_USAGE = "usage: tempad review [--days <positive integer>]";

function runReview(args: string[], context: W5Context): number {
  let daysValue: string | undefined;
  try {
    const { values } = parseArgs({
      args,
      options: { days: { type: "string" } },
      strict: true,
    });
    daysValue = values.days;
  } catch {
    // node:util's parseArgs itself throws on a value that looks like another
    // flag (e.g. `--days -5` un-joined) before any of our own validation
    // runs; treated the same as a value that fails the pattern below.
    context.stdout(REVIEW_USAGE);
    return 2;
  }

  let days = REVIEW_DEFAULT_DAYS;
  if (daysValue !== undefined) {
    // Same convention as `runQuiet`'s duration argument: a strict pattern
    // match, not a bare `parseInt`, so a typo (`--days abc`, `--days=-5`)
    // fails loudly with a usage message instead of silently producing a
    // `NaN`/negative bound and an empty or wrong review listing.
    const match = daysValue.match(/^[1-9]\d*$/);
    if (!match) {
      context.stdout(REVIEW_USAGE);
      return 2;
    }
    days = Number.parseInt(daysValue, 10);
  }
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const doubtedTraces = context.database
    .query(
      `SELECT traces.id as id, traces.what as what, traces.doubt as doubt FROM traces
        JOIN stints ON stints.id = traces.stint_id
        WHERE traces.doubt IS NOT NULL AND traces.retracted_at IS NULL AND traces.started_at >= ?
          AND stints.dismissed_at IS NULL AND stints.retracted_at IS NULL
        ORDER BY traces.started_at ASC`,
    )
    .all(since) as { id: string; what: string; doubt: string }[];
  for (const trace of doubtedTraces) {
    context.stdout(
      `trace ${trace.id} doubt (${trace.doubt}) — ${trace.what} — tempad trace list --stint <id>`,
    );
  }

  const expiredQuestions = context.database
    .query(
      "SELECT id, text, kind, guess, session_id as sessionId FROM questions WHERE state = 'expired' ORDER BY rowid ASC",
    )
    .all() as {
    id: string;
    text: string;
    kind: string;
    guess: string | null;
    sessionId: string | null;
  }[];
  for (const question of expiredQuestions) {
    // The verifier's two kinds render the same hand-back the hook shows, so an
    // expired doubt is answerable straight from `tempad review`; older kinds keep
    // their generic line.
    if (question.kind === "declare" && question.sessionId !== null) {
      // Same rule as the hook's context: a session that has an active quest has
      // declared, whatever it was lacking when the question expired.
      const declaredSince = activeDeclaredQuests(context.database, {
        sessionId: question.sessionId,
        at: new Date().toISOString(),
      });
      if (declaredSince.length > 0) continue;
      context.stdout(
        `question ${question.id} expired — ${buildDeclareHandback(question.sessionId)}`,
      );
      continue;
    }
    if (question.kind === "belongs") {
      const declared =
        question.sessionId === null
          ? []
          : activeDeclaredQuests(context.database, {
              sessionId: question.sessionId,
              at: new Date().toISOString(),
            });
      context.stdout(
        `question ${question.id} expired — ${buildBelongsHandback(
          declared.map((quest) => ({ title: quest.title, alias: quest.alias })),
          question.guess ?? "something else",
          question.id,
        )}`,
      );
      continue;
    }
    context.stdout(
      `question ${question.id} expired (${question.text}) — tempad answer ${question.id} --quest <id> --why "…"`,
    );
  }

  const unconfirmedQuests = context.database
    .query(
      "SELECT id, title FROM quests WHERE confirmed = 0 AND retracted_at IS NULL ORDER BY created_at ASC",
    )
    .all() as { id: string; title: string }[];
  for (const quest of unconfirmedQuests) {
    context.stdout(
      `quest ${quest.id} unconfirmed (${quest.title}) — tempad quest confirm ${quest.id}`,
    );
  }

  const lowConfidenceTraces = context.database
    .query(
      "SELECT id, what FROM traces WHERE confidence < 0.5 AND retracted_at IS NULL ORDER BY started_at ASC",
    )
    .all() as { id: string; what: string }[];
  for (const trace of lowConfidenceTraces) {
    context.stdout(
      `trace ${trace.id} low confidence (${trace.what}) — tempad trace list --stint <id>`,
    );
  }

  return 0;
}

/**
 * What each command class needs from the environment and from disk, so the dispatcher
 * can validate it before any handler (or database) is touched. `needs` is read from
 * the code of the handlers below; `W5_RUN_NEEDS` / `W5_EVAL_NEEDS` are what they pass
 * to `requireFields`.
 */
export interface CommandPlan {
  /** Command as shown in a `ConfigError`, e.g. `tempad w5 run`. */
  label: string;
  needs: readonly ConfigKey[];
  /** False for commands that touch neither the database nor TEMPAD_HOME. */
  opensDatabase: boolean;
  /** Hook-called commands: on an unconfigured home, exit 0 silently instead of failing. */
  silentWhenUnconfigured: boolean;
}

export const W5_RUN_NEEDS = ["claudeDirs", "hostSlug"] as const;
export const W5_EVAL_NEEDS = ["tz"] as const;
/** Own-host classification with push sync on: `backfill`/`eval` filter sessions by it. */
export const W5_SYNC_NEEDS = ["hostSlug"] as const;

const W5_DATABASE_SUBCOMMANDS = new Set([
  "enqueue",
  "context",
  "run",
  "backfill",
  "dedupe",
  "eval",
]);

/** Returns null when `command` + `args` name no known w5 subcommand. */
export function planW5Command(
  command: "w5" | "quiet" | "review",
  args: string[],
  options: {
    /**
     * Whether `[sync]` is enabled; a function is called only for the
     * subcommands that depend on it (backfill, eval), so a malformed
     * `[sync]` never breaks the hook, quiet or review commands.
     */
    syncEnabled?: boolean | (() => boolean);
  } = {},
): CommandPlan | null {
  if (command === "quiet" || command === "review") {
    return {
      label: `tempad ${command}`,
      needs: [],
      opensDatabase: true,
      silentWhenUnconfigured: false,
    };
  }
  const subcommand = args[0] ?? "";
  const label = `tempad w5 ${subcommand}`;
  if (subcommand === "hook") {
    return { label, needs: [], opensDatabase: false, silentWhenUnconfigured: false };
  }
  if (!W5_DATABASE_SUBCOMMANDS.has(subcommand)) return null;
  const sync = (): readonly ConfigKey[] => {
    const enabled =
      typeof options.syncEnabled === "function" ? options.syncEnabled() : options.syncEnabled;
    return enabled ? W5_SYNC_NEEDS : [];
  };
  const needs: readonly ConfigKey[] =
    subcommand === "run"
      ? W5_RUN_NEEDS
      : subcommand === "eval"
        ? [...W5_EVAL_NEEDS, ...sync()]
        : subcommand === "backfill"
          ? sync()
          : [];
  return {
    label,
    needs,
    opensDatabase: true,
    silentWhenUnconfigured: subcommand === "enqueue" || subcommand === "context",
  };
}

export { settingsPathFor };

function runHook(args: string[]): number {
  const [action, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      scope: { type: "string", default: "user" },
      bin: { type: "string" },
    },
    strict: true,
  });
  const scope = values.scope === "project" ? "project" : "user";

  try {
    return applyHookAction(action, settingsPathFor(scope), values.bin);
  } catch (error) {
    if (error instanceof SettingsParseError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

function applyHookAction(
  action: string | undefined,
  settingsPath: string,
  binary: string | undefined,
): number {
  if (action === "install") {
    if (hasUnstableInstall(binary)) {
      console.error(UNSTABLE_INSTALL_MESSAGE);
      return 1;
    }
    if (binary) {
      installHooks(settingsPath, binary);
    } else {
      installHooks(settingsPath);
    }
    console.log(`installed tempad hooks in ${settingsPath}`);
    console.log(PLUGIN_RECOMMENDATION_MESSAGE);
    return 0;
  }
  if (action === "uninstall") {
    const hadHooks = hasTempadHooks(settingsPath);
    uninstallHooks(settingsPath);
    console.log(
      hadHooks
        ? `removed tempad hooks from ${settingsPath}`
        : `no tempad hooks in ${settingsPath}; nothing changed`,
    );
    return 0;
  }
  return 2;
}

async function runBackfill(args: string[], context: W5Context): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      days: { type: "string" },
      model: { type: "string" },
      force: { type: "boolean", default: false },
    },
    strict: true,
  });

  const days = values.days
    ? Number.parseInt(values.days, 10)
    : context.intentConfig.w5.backfillDays;

  if (context.intentConfig.w5.backend === "api" && !anthropicApiKey(context.config.home)) {
    context.stdout("ANTHROPIC_API_KEY not set");
    return 1;
  }
  const classifier = buildClassifier(context.config, context.intentConfig, values.model);

  const result = await backfill(
    context.database,
    context.config,
    context.intentConfig.w5,
    classifier,
    {
      days,
      now: new Date().toISOString(),
      log: (line) => {
        log(context.config, line);
        context.stdout(line);
      },
      force: values.force === true,
      // With push sync on, classify only this host's sessions; the others'
      // traces arrive as events from the host that has the transcript.
      ...(isSyncEnabled(context.config.home) ? { hostSlug: context.config.hostSlug } : {}),
    },
  );

  context.stdout(
    `classified=${result.sessionsClassified} windows=${result.windowsClassified} failed=${result.windowsFailed} skipped=${result.sessionsSkipped} windows_skipped=${result.windowsSkipped}`,
  );

  const attemptedWindows = result.windowsClassified + result.windowsFailed;
  if (attemptedWindows > 0 && result.windowsClassified === 0) return 1;
  return 0;
}

async function runEvalCommand(args: string[], context: W5Context): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      db: { type: "string" },
      declare: { type: "string" },
    },
    strict: true,
  });

  const evalConfig = requireFields("tempad w5 eval", context.config, W5_EVAL_NEEDS);

  if (!values.from || !values.to) {
    context.stdout(
      "usage: tempad w5 eval --from <date> --to <date> [--db <path>] [--declare <file>]",
    );
    return 2;
  }

  try {
    validateEvalRange(values.from, values.to, evalConfig.tz);
  } catch (error) {
    if (error instanceof InvalidEvalRangeError) {
      context.stdout(error.message);
      return 1;
    }
    throw error;
  }

  if (context.intentConfig.w5.backend === "api" && !anthropicApiKey(context.config.home)) {
    context.stdout("ANTHROPIC_API_KEY not set");
    return 1;
  }
  const classifier = buildClassifier(context.config, context.intentConfig);
  const sourceDbPath = values.db ?? join(context.config.home, "tempad.db");
  const scratchDir = join(context.config.home, "scratch");
  mkdirSync(scratchDir, { recursive: true });

  let metrics: Awaited<ReturnType<typeof runEval>>;
  try {
    metrics = await runEval({
      from: values.from,
      to: values.to,
      sourceDbPath,
      scratchDir,
      now: new Date().toISOString(),
      classifier,
      log: (line) => {
        log(context.config, line);
        context.stdout(line);
      },
      declareFile: values.declare,
      timeZone: evalConfig.tz,
      ...(isSyncEnabled(context.config.home) ? { hostSlug: context.config.hostSlug } : {}),
    });
  } catch (error) {
    if (error instanceof InvalidDeclareFileError) {
      context.stdout(error.message);
      return 1;
    }
    throw error;
  }

  context.stdout(`copied_db=${metrics.copiedDbPath}`);
  context.stdout(
    `retracted_before_rerun traces=${metrics.resetTraces} stints=${metrics.resetStints} quests=${metrics.resetQuests}`,
  );
  context.stdout(`traces=${metrics.traces}`);
  context.stdout(`stints=${metrics.stints}`);
  context.stdout(`ratio=${metrics.ratio.toFixed(3)}`);
  context.stdout(
    `median_activity_duration_minutes=${metrics.medianStintDurationMinutes.toFixed(1)}`,
  );
  context.stdout(`continues_links=${metrics.continuesLinks}`);
  context.stdout(`doubts=${metrics.doubts}`);
  context.stdout(`doubts_answered=${metrics.doubtsAnswered}`);
  context.stdout(`doubts_recorded=${metrics.doubtsRecorded}`);
  context.stdout(`traces_unattributed=${metrics.tracesUnattributed}`);
  context.stdout(`declarations_skipped=${metrics.declarationsSkipped}`);
  context.stdout(`unknown_activity_ids=${metrics.unknownStintIds}`);
  context.stdout(`overlap_dropped=${metrics.overlapDropped}`);
  context.stdout(`quest_proposed_on_matched=${metrics.questProposedOnMatched}`);
  context.stdout(`selector_defaulted=${metrics.selectorDefaulted}`);
  context.stdout(`selector_ambiguous=${metrics.selectorAmbiguous}`);
  context.stdout(`sessions_declared=${metrics.sessionsDeclared}`);
  context.stdout(`sessions_inferred=${metrics.sessionsInferred}`);
  context.stdout(`stints_dismissed=${metrics.stintsDismissed}`);
  context.stdout(`plan_stints_hit=${metrics.planStintsHit}`);
  context.stdout(`stints_new=${metrics.stintsNew}`);
  for (const stint of metrics.sample) {
    context.stdout(
      `sample: what=${JSON.stringify(stint.what)} why=${JSON.stringify(stint.why)} quest=${
        stint.questTitle ?? "-"
      } duration_minutes=${stint.durationMinutes ?? "-"} session=${stint.sessionTitle ?? "-"}`,
    );
  }

  return 0;
}

function runDedupe(args: string[], context: W5Context): number {
  const { values } = parseArgs({
    args,
    options: { "dry-run": { type: "boolean", default: false } },
    strict: true,
  });

  const result = dedupe(context.database, { dryRun: values["dry-run"] === true });
  context.stdout(`traces=${result.traces} stints=${result.stints} quests=${result.quests}`);
  return 0;
}

/** `tempad w5 hook ...`: edits settings.json only, needs no config and no database. */
export function runW5HookCommand(args: string[]): number {
  return runHook(args);
}

export async function runW5Command(args: string[], context: W5Context): Promise<number> {
  const [subcommand, ...rest] = args;

  if (subcommand === "enqueue") return runEnqueue(rest, context);
  if (subcommand === "context") return runContext(rest, context);
  if (subcommand === "run") return runRun(rest, context);
  if (subcommand === "hook") return runHook(rest);
  if (subcommand === "backfill") return runBackfill(rest, context);
  if (subcommand === "dedupe") return runDedupe(rest, context);
  if (subcommand === "eval") return runEvalCommand(rest, context);

  return 2;
}

export function runQuietCommand(args: string[], context: W5Context): number {
  return runQuiet(args, context);
}

export function runReviewCommand(args: string[], context: W5Context): number {
  return runReview(args, context);
}
