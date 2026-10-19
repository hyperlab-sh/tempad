import { existsSync, readFileSync } from "node:fs";
import { describeValue } from "../config/describe-value";

/** The longest look-back `tempad scry --days` accepts, so a config default cannot exceed it. */
const MAX_BACKFILL_DAYS = 3650;

const W5_BACKENDS = ["claude-cli", "api"] as const;
const W5_MODES = ["declared", "inferred"] as const;

export type W5Backend = (typeof W5_BACKENDS)[number];

export interface W5Config {
  model: string;
  throttleMinutes: number;
  watchTurns: number;
  askMinStintMinutes: number;
  askBudgetMinutes: number;
  askExpireTurns: number;
  backfillDays: number;
  backend: W5Backend;
  claudeCommand: string;
  timeoutSeconds: number;
  stintIdleMinutes: number;
  stintMinMinutes: number;
  memoryHours: number;
  memoryStints: number;
  memoryQuests: number;
  overlapMessages: number;
  mode: (typeof W5_MODES)[number];
  inferenceFallback: boolean;
  /** The model that classifies a session's kind from its first message (`src/sessions/kind.ts`). */
  sessionKindModel: string;
  /** How many sessions one `tempad sync` sends to that model at most; 0 sends none. */
  sessionKindBatch: number;
}

export interface IntentConfig {
  hero?: { name: string };
  parties: { slug: string; name: string; joined?: string; description?: string }[];
  clients: { slug: string; name: string }[];
  w5: W5Config;
}

export function defaultIntentConfig(): IntentConfig {
  return {
    parties: [],
    clients: [],
    w5: {
      model: "claude-haiku-4-5-20251001",
      throttleMinutes: 10,
      watchTurns: 3,
      askMinStintMinutes: 20,
      askBudgetMinutes: 30,
      askExpireTurns: 2,
      backfillDays: 15,
      backend: "claude-cli",
      claudeCommand: "claude",
      timeoutSeconds: 180,
      stintIdleMinutes: 45,
      stintMinMinutes: 5,
      memoryHours: 8,
      memoryStints: 10,
      memoryQuests: 20,
      overlapMessages: 3,
      mode: "declared",
      inferenceFallback: true,
      sessionKindModel: "haiku",
      sessionKindBatch: 20,
    },
  };
}

/** Why `loadIntentConfig` is warning, so a caller can summarize the two apart. */
export type ConfigWarningKind = "renamed-key" | "wrong-type";

export type ConfigWarn = (message: string, kind: ConfigWarningKind) => void;

/** Where a warning comes from and how to report it. */
interface Reporter {
  warn: ConfigWarn;
  source: string;
}

/** The one wording of "this key has the wrong type; the default stays". */
function wrongType(
  { warn, source }: Reporter,
  where: string,
  expected: string,
  value: unknown,
  fallback: unknown,
): void {
  warn(
    `${source}: ${where} must be ${expected}, got ${describeValue(value)}; using the default ${JSON.stringify(fallback)}. Fix the value.`,
    "wrong-type",
  );
}

function parseChoice<T extends string>(
  value: unknown,
  choices: readonly T[],
  fallback: T,
  where: string,
  reporter: Reporter,
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (choices as readonly string[]).includes(value)) {
    return value as T;
  }
  wrongType(reporter, where, `one of ${choices.map((c) => `"${c}"`).join(", ")}`, value, fallback);
  return fallback;
}

/** An optional string key: absent is `undefined`, a non-string warns and is `undefined` too. */
function optionalString(
  record: Record<string, unknown>,
  key: string,
  where: string,
  { warn, source }: Reporter,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  warn(
    `${source}: ${where}.${key} must be a string, got ${describeValue(value)}; ignoring it. Fix the value.`,
    "wrong-type",
  );
  return undefined;
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}: missing ${key}`);
  return value;
}

/**
 * Old `[w5]` key -> current key, for configs written before the 2026-09-07
 * vocabulary rename. Unlike events, a TOML file is hand-edited and lives
 * outside the repository, so it is read through this alias rather than
 * migrated: an operator's existing `tempad.toml` keeps working, and the
 * warning tells them what to rename it to.
 */
const LEGACY_W5_KEYS: Readonly<Record<string, string>> = {
  ask_min_activity_minutes: "ask_min_stint_minutes",
  activity_idle_minutes: "stint_idle_minutes",
  memory_activities: "memory_stints",
};

/**
 * Rewrites legacy `[w5]` keys to their current names, warning once per key.
 * The current name wins when both are present, so a half-migrated file
 * behaves the way its author most recently intended.
 */
function resolveLegacyW5Keys(
  w5: Record<string, unknown>,
  { warn, source }: Reporter,
): Record<string, unknown> {
  const resolved = { ...w5 };
  for (const [old, current] of Object.entries(LEGACY_W5_KEYS)) {
    if (!(old in resolved)) continue;
    const value = resolved[old];
    delete resolved[old];
    if (current in w5) {
      warn(
        `${source}: [w5].${old} is ignored; using [w5].${current}. Remove the old key.`,
        "renamed-key",
      );
      continue;
    }
    resolved[current] = value;
    warn(
      `${source}: [w5].${old} was renamed to [w5].${current}. Update your config.`,
      "renamed-key",
    );
  }
  return resolved;
}

export function loadIntentConfig(
  tomlPath: string,
  warn: ConfigWarn = (message) => console.warn(message),
): IntentConfig {
  if (!existsSync(tomlPath)) {
    return defaultIntentConfig();
  }
  const parsed = Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as Record<string, unknown>;
  const config = defaultIntentConfig();
  const reporter: Reporter = { warn, source: tomlPath };
  const hero = parsed.hero as Record<string, unknown> | undefined;
  if (hero) config.hero = { name: requireString(hero, "name", "[hero]") };
  for (const [index, raw] of (
    (parsed.parties as Record<string, unknown>[] | undefined) ?? []
  ).entries()) {
    const where = `[[parties]] #${index + 1}`;
    config.parties.push({
      slug: requireString(raw, "slug", where),
      name: requireString(raw, "name", where),
      joined: optionalString(raw, "joined", where, reporter),
      description: optionalString(raw, "description", where, reporter),
    });
  }
  for (const [index, raw] of (
    (parsed.clients as Record<string, unknown>[] | undefined) ?? []
  ).entries()) {
    const where = `[[clients]] #${index + 1}`;
    config.clients.push({
      slug: requireString(raw, "slug", where),
      name: requireString(raw, "name", where),
    });
  }
  const rawW5 = parsed.w5;
  if (
    rawW5 !== undefined &&
    (typeof rawW5 !== "object" || rawW5 === null || Array.isArray(rawW5))
  ) {
    warn(
      `${tomlPath}: [w5] must be a table, got ${describeValue(rawW5)}; using the defaults for every [w5] key. Fix the value.`,
      "wrong-type",
    );
  } else if (rawW5 !== undefined) {
    const w5 = resolveLegacyW5Keys(rawW5 as Record<string, unknown>, reporter);
    const typed =
      <T>(expected: string, accepts: (value: unknown) => value is T) =>
      (key: string, fallback: T): T => {
        const value = w5[key];
        if (value === undefined) return fallback;
        if (accepts(value)) return value;
        wrongType(reporter, `[w5].${key}`, expected, value, fallback);
        return fallback;
      };
    // Finite always (TOML allows `nan` and `inf`). Counts are safe whole numbers (an integer
    // such as 1e20 is one to `Number.isInteger` but SQLite rejects it as a `LIMIT`, failing
    // every window), which keeps `memory_stints`, `memory_quests` and `overlap_messages` valid
    // as a SQL `LIMIT`; minutes and hours may be fractions; 0 is a real setting for the ones
    // that are thresholds.
    const isNumber = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value);
    const count = typed(
      "a whole number, 0 or more",
      (value): value is number => isNumber(value) && Number.isSafeInteger(value) && value >= 0,
    );
    const amount = typed(
      "a number, 0 or more",
      (value): value is number => isNumber(value) && value >= 0,
    );
    const positive = typed(
      "a number above 0",
      (value): value is number => isNumber(value) && value > 0,
    );
    const days = typed(
      `a whole number from 1 to ${MAX_BACKFILL_DAYS}`,
      (value): value is number =>
        isNumber(value) && Number.isInteger(value) && value >= 1 && value <= MAX_BACKFILL_DAYS,
    );
    const boolean = typed("true or false", (value): value is boolean => typeof value === "boolean");
    const string = typed("a string", (value): value is string => typeof value === "string");
    config.w5 = {
      model: string("model", config.w5.model),
      throttleMinutes: amount("throttle_minutes", config.w5.throttleMinutes),
      watchTurns: count("watch_turns", config.w5.watchTurns),
      askMinStintMinutes: amount("ask_min_stint_minutes", config.w5.askMinStintMinutes),
      askBudgetMinutes: amount("ask_budget_minutes", config.w5.askBudgetMinutes),
      askExpireTurns: count("ask_expire_turns", config.w5.askExpireTurns),
      backfillDays: days("backfill_days", config.w5.backfillDays),
      backend: parseChoice(w5.backend, W5_BACKENDS, config.w5.backend, "[w5].backend", reporter),
      claudeCommand: string("claude_command", config.w5.claudeCommand),
      timeoutSeconds: positive("timeout_seconds", config.w5.timeoutSeconds),
      stintIdleMinutes: amount("stint_idle_minutes", config.w5.stintIdleMinutes),
      stintMinMinutes: amount("stint_min_minutes", config.w5.stintMinMinutes),
      memoryHours: amount("memory_hours", config.w5.memoryHours),
      memoryStints: count("memory_stints", config.w5.memoryStints),
      memoryQuests: count("memory_quests", config.w5.memoryQuests),
      overlapMessages: count("overlap_messages", config.w5.overlapMessages),
      mode: parseChoice(w5.mode, W5_MODES, config.w5.mode, "[w5].mode", reporter),
      inferenceFallback: boolean("inference_fallback", config.w5.inferenceFallback),
      sessionKindModel: string("session_kind_model", config.w5.sessionKindModel),
      sessionKindBatch: count("session_kind_batch", config.w5.sessionKindBatch),
    };
  }
  return config;
}
