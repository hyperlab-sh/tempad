import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { QuestionRow } from "./questions";

interface HookEntry {
  type: "command";
  command: string;
  tempad?: boolean;
}

interface HookMatcher {
  hooks: HookEntry[];
}

interface HooksFragment {
  Stop: HookMatcher[];
  PreCompact: HookMatcher[];
  SessionEnd: HookMatcher[];
  UserPromptSubmit: HookMatcher[];
}

interface SettingsFile {
  hooks?: Partial<Record<string, HookMatcher[]>>;
  [key: string]: unknown;
}

/**
 * One line `tempad w5 hook install` prints after writing settings.json. The
 * Claude Code plugin is the recommended route; both can be installed because the
 * plugin's hook scripts stand down while a settings.json hook marked
 * `"tempad": true` exists (see `packages/core/hooks/w5-common.sh`).
 */
export const PLUGIN_RECOMMENDATION_MESSAGE =
  "Recommended: install the Claude Code plugin instead (claude plugin install tempad@hyperlab). Installing both is safe; the plugin's hooks stand down while these settings.json hooks exist.";

const PACKAGE_ROOT = join(import.meta.dir, "..", "..");
const HOOKS_DIR = join(PACKAGE_ROOT, "hooks");
const CLI_PATH = join(PACKAGE_ROOT, "src", "cli.ts");

/**
 * Message `tempad w5 hook install` prints when it runs from a throwaway location. `bunx`
 * unpacks a package into `$TMPDIR/bunx-<uid>-<name>@<version>/` (bun 1.3), and the global
 * install cache lives under `~/.bun/install/cache/`; settings.json entries pointing there
 * stop working as soon as bun clears them.
 */
export const UNSTABLE_INSTALL_MESSAGE =
  "tempad w5 hook install: this copy of tempad lives in a temporary location (bunx or a cache), and the hooks it would write into settings.json would break once that is cleared. The supported route for bunx users is the plugin: claude plugin install tempad@hyperlab. `w5 hook install` is for a checkout or a global install (bun add -g tempad).";

function pathVariants(path: string): string[] {
  try {
    return [path, realpathSync(path)];
  } catch {
    return [path];
  }
}

/**
 * True when `path` sits where bun keeps disposable packages: a `bunx-<uid>-` directory,
 * bun's install cache, or the operating system's temp directory.
 */
export function isUnstableInstallPath(path: string): boolean {
  const temporaryRoots = [
    ...pathVariants(tmpdir()),
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
  ].map((root) => root.replace(/\/+$/, ""));
  return pathVariants(path).some(
    (candidate) =>
      /(^|\/)bunx-\d+-/.test(candidate) ||
      candidate.includes("/.bun/install/cache/") ||
      temporaryRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`)),
  );
}

/** True when the hooks `installHooks` would write (scripts, and `binPath` if given) are on disposable ground. */
export function hasUnstableInstall(binPath: string = CLI_PATH): boolean {
  return [binPath, stopHookScriptPath(), promptHookScriptPath()].some(isUnstableInstallPath);
}

export function stopHookScriptPath(): string {
  return join(HOOKS_DIR, "w5-stop.sh");
}

export function promptHookScriptPath(): string {
  return join(HOOKS_DIR, "w5-prompt.sh");
}

function tempadBinInvocation(binPath: string): string {
  return `bun ${binPath}`;
}

function hookCommand(scriptPath: string, binPath: string): string {
  return `TEMPAD_BIN="${tempadBinInvocation(binPath)}" bash ${scriptPath}`;
}

export function renderHookSettings(binPath: string = CLI_PATH): HooksFragment {
  const stopCommand = hookCommand(stopHookScriptPath(), binPath);
  const promptCommand = hookCommand(promptHookScriptPath(), binPath);

  const stopMatcher: HookMatcher = {
    hooks: [{ type: "command", command: stopCommand, tempad: true }],
  };
  const promptMatcher: HookMatcher = {
    hooks: [{ type: "command", command: promptCommand, tempad: true }],
  };

  return {
    Stop: [stopMatcher],
    PreCompact: [stopMatcher],
    SessionEnd: [stopMatcher],
    UserPromptSubmit: [promptMatcher],
  };
}

function readSettings(settingsPath: string): SettingsFile {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
}

function writeSettings(settingsPath: string, settings: SettingsFile): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function removeTempadEntries(matchers: HookMatcher[] | undefined): HookMatcher[] {
  if (!matchers) return [];
  return matchers
    .map((matcher) => ({
      ...matcher,
      hooks: matcher.hooks.filter((hook) => hook.tempad !== true),
    }))
    .filter((matcher) => matcher.hooks.length > 0);
}

export function installHooks(settingsPath: string, binPath: string = CLI_PATH): void {
  const settings = readSettings(settingsPath);
  const fragment = renderHookSettings(binPath);
  const hooks = { ...(settings.hooks ?? {}) };

  for (const eventName of Object.keys(fragment) as (keyof HooksFragment)[]) {
    const withoutTempad = removeTempadEntries(hooks[eventName]);
    hooks[eventName] = [...withoutTempad, ...fragment[eventName]];
  }

  writeSettings(settingsPath, { ...settings, hooks });
}

/**
 * True when `settingsPath` holds a hook marked `"tempad": true`, i.e. one written by
 * `tempad w5 hook install`. Falls back to a text match when the file is not valid JSON,
 * the same test the hook scripts' stand-down check (`w5-common.sh`) applies.
 */
export function hasTempadHooks(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;
  const text = readFileSync(settingsPath, "utf8");
  try {
    const settings = JSON.parse(text) as SettingsFile;
    return Object.values(settings.hooks ?? {}).some((matchers) =>
      (matchers ?? []).some((matcher) =>
        (matcher.hooks ?? []).some((hook) => hook.tempad === true),
      ),
    );
  } catch {
    return /"tempad"\s*:\s*true/.test(text);
  }
}

export function uninstallHooks(settingsPath: string): void {
  const settings = readSettings(settingsPath);
  if (!settings.hooks) return;

  const hooks = { ...settings.hooks };
  for (const eventName of Object.keys(hooks)) {
    hooks[eventName] = removeTempadEntries(hooks[eventName]);
  }

  writeSettings(settingsPath, { ...settings, hooks });
}

export function buildDeclarationLine(
  active: { title: string; alias: string }[],
  sessionId: string,
): string {
  const quests =
    active.length === 0
      ? "none"
      : active.map((quest) => `${quest.title} [${quest.alias}]`).join(", ");
  return `tempad: session ${sessionId}, active quests: ${quests}. Declare with the tempad-quest skill if this prompt starts a different outcome.`;
}

/**
 * The hand-back for a doubt the verifier raised. Rendered fresh at read time from
 * the question's `kind`/`guess` plus the quests active *now*, never from a
 * sentence stored when the question was asked: a title can change, a quest can be
 * declared or ended since, and the stored `text` is internal/debug only for the
 * verifier's two kinds. The doubt is against every active quest at once, so all
 * of them are named -- answering it means picking one or saying it is something
 * else entirely.
 */
export function buildBelongsHandback(
  active: { title: string; alias: string }[],
  guess: string,
  questionId: string,
): string {
  const quests =
    active.length === 0
      ? "none"
      : active.map((quest) => `${quest.title} [${quest.alias}]`).join(", ");
  return [
    `w5 thinks the last stretch is not part of your active quests (${quests}) (looks like: ${guess}). Reply:`,
    `  tempad answer ${questionId} --belongs --why "<reason>"`,
    "  or",
    `  tempad answer ${questionId} --quest <id>|new:"<title>" --why "<reason>" [--origin current --trigger "<sentence>" --kind waiting|blocker|curiosity|unknown]`,
    "Ask the user if you are not sure.",
  ].join("\n");
}

/** The hand-back for a session that has declared nothing yet. */
export function buildDeclareHandback(sessionId: string): string {
  return [
    "w5 has no declared quest for this session. Reply:",
    `  tempad quest declare --session ${sessionId} --quest <id>|--new "<title>" --outcome "<text>" [--commitment ...] --by agent`,
  ].join("\n");
}

export function buildAdditionalContext(
  questions: QuestionRow[],
  context?: {
    activeQuests: { title: string; alias: string }[];
    sessionId: string;
    guessFor: (questionId: string) => string | null;
  },
): string {
  if (questions.length === 0) return "";

  const lines: string[] = [];
  for (const question of questions) {
    if (context !== undefined && question.kind === "declare") {
      lines.push(buildDeclareHandback(context.sessionId));
      continue;
    }
    if (context !== undefined && question.kind === "belongs") {
      lines.push(
        buildBelongsHandback(
          context.activeQuests,
          context.guessFor(question.id) ?? "something else",
          question.id,
        ),
      );
      continue;
    }
    lines.push(
      `w5 noticed a possible shift in what you're working on (question ${question.id}, ${question.kind}).`,
    );
    lines.push(`To resolve it: tempad answer ${question.id} --quest <id|new:"title"> --why "…"`);
    lines.push("If you're not sure, keep working — it will follow up later.");
  }
  return lines.join("\n");
}
