/**
 * Every command and the nested paths below it (`w5 hook install`), as `dispatch` accepts them.
 * `help` and `--help` are answered from this table, and the help tests walk it.
 */
export const COMMAND_TREE: Readonly<Record<string, readonly string[]>> = {
  hero: ["init"],
  party: ["add", "leave", "list"],
  client: ["add"],
  saga: ["add", "reword", "replace", "end", "edit", "list"],
  quest: [
    "add",
    "reword",
    "replace",
    "end",
    "edit",
    "confirm",
    "merge",
    "pause",
    "resume",
    "done",
    "abandon",
    "branch",
    "return",
    "retract",
    "delete",
    "list",
    "declare",
  ],
  stint: ["list"],
  trace: ["list"],
  impact: ["set", "list", "import"],
  answer: [],
  rebuild: [],
  setup: [],
  init: [],
  sync: ["monday", "github", "claude"],
  report: ["daily", "project", "hourly", "weekly"],
  w5: [
    "enqueue",
    "context",
    "run",
    "hook",
    "hook install",
    "hook uninstall",
    "backfill",
    "dedupe",
    "eval",
  ],
  quiet: [],
  review: [],
  scry: [],
  schedule: ["install", "remove", "status"],
  skill: ["install"],
  project: ["register", "list", "reresolve"],
};

interface UsageEntry {
  /** The command paths this text documents; the first one names the command it is listed under. */
  paths: readonly string[];
  text: string;
}

/**
 * The one copy of every usage text. The global list, `tempad help <path>` and
 * `<path> --help` all read it, and the `*_USAGE` constants of the commands derive from it.
 */
export const USAGE_ENTRIES: readonly UsageEntry[] = [
  {
    paths: ["setup", "init"],
    text: "tempad setup [--non-interactive] [--home <dir>] [--force] [--no-verify] [--<variable> <value> ...]   (create TEMPAD_HOME with .env and tempad.toml)",
  },
  {
    paths: ["sync", "sync monday", "sync github", "sync claude"],
    text: "tempad sync [monday|github|claude] [--full] | --push | --pull | --push --pull | --forget [--force] | --rejoin <server-id>   (--rejoin: let sync use a server --forget left, accepting overwrites; --forget: after removing [sync], drop the sync triggers, tombstones and cursors for good; local only; refuses while changes never reached the server unless --force)",
  },
  {
    paths: ["report", "report daily", "report project", "report hourly", "report weekly"],
    text: "tempad report <daily|project|hourly|weekly> --from <date> --to <date> [--org X] [--project Y] [--out path] [--as-of <iso>] [--party <slug>] [--client <slug>] [--pr-date merged|authored]",
  },
  { paths: ["hero init"], text: 'tempad hero init "<name>"' },
  { paths: ["party add"], text: 'tempad party add <slug> "<name>" [--joined YYYY-MM-DD]' },
  { paths: ["party leave"], text: 'tempad party leave <slug> --reason "..."' },
  { paths: ["party list"], text: "tempad party list" },
  { paths: ["client add"], text: 'tempad client add <slug> "<name>"' },
  {
    paths: ["saga add"],
    text: 'tempad saga add --owner hero|party:<slug> "<title>" [--statement "..."]',
  },
  { paths: ["saga reword"], text: 'tempad saga reword <id> "<title>" [--statement]' },
  {
    paths: ["saga replace"],
    text: 'tempad saga replace <id> "<title>" [--statement] --reason "..."',
  },
  { paths: ["saga end"], text: "tempad saga end <id> --reason achieved|abandoned" },
  { paths: ["saga list"], text: "tempad saga list [--all] [--as-of <iso>]" },
  { paths: ["saga edit"], text: 'tempad saga edit <id> "<title>"' },
  {
    paths: ["quest add"],
    text: 'tempad quest add --owner hero|party:<slug> [--serves <id>] "<title>" [--outcome] [--done] [--due] [--budget Nh|Nm] [--commitment]',
  },
  { paths: ["quest reword"], text: 'tempad quest reword <id> "<title>" [--outcome]' },
  {
    paths: ["quest replace"],
    text: 'tempad quest replace <id> "<title>" [--outcome] --reason "..."',
  },
  { paths: ["quest end"], text: "tempad quest end <id> --reason ..." },
  { paths: ["quest edit"], text: 'tempad quest edit <id> "<title>"' },
  {
    paths: ["quest branch"],
    text: 'tempad quest branch <id> --deviates-from <quest-id|stint-id> --trigger "..." [--kind ...] [--at <iso>]',
  },
  { paths: ["quest confirm"], text: "tempad quest confirm <id>" },
  { paths: ["quest merge"], text: "tempad quest merge <id> --into <id>" },
  {
    paths: ["quest pause", "quest resume", "quest done", "quest abandon"],
    text: "tempad quest pause|resume|done|abandon <id> [--reason]",
  },
  { paths: ["quest return"], text: "tempad quest return <id> --to <quest-id>" },
  {
    paths: ["quest retract", "quest delete"],
    text: 'tempad quest retract <id> --reason "..." [--force]   (undo a quest created by mistake; alias: delete)',
  },
  {
    paths: ["quest declare"],
    text: 'tempad quest declare --session <id> [--parent <id>] (--quest <id> | --new "<title>" --outcome "<text>" [--commitment promised|personal|exploratory] [--project <slug>] [--serves <saga id>] [--advances <quest id> | --deviates-from <quest id> --trigger "<sentence>" --kind waiting|blocker|curiosity|unknown] [--origin <quest id> --trigger "<sentence>" --kind waiting|blocker|curiosity|unknown] | --done <quest>) [--plan "a; b; c"] [--by agent|hero] [--at <iso>]',
  },
  {
    paths: ["quest list"],
    text: "tempad quest list [--all] [--unconfirmed] [--side] [--as-of <iso>]",
  },
  { paths: ["stint list"], text: "tempad stint list [--open] [--quest <id>]" },
  { paths: ["trace list"], text: "tempad trace list [--since <iso>] [--stint <id>]" },
  { paths: ["impact set"], text: 'tempad impact set <ref> "<text>" [--theme <t>]' },
  {
    paths: ["impact list"],
    text: "tempad impact list [--project <p>] [--from <date> --to <date>]",
  },
  { paths: ["impact import"], text: "tempad impact import <file.json>" },
  {
    paths: ["answer"],
    text: 'tempad answer <question-id> --belongs | --quest <id|new:"title"> [--why "..."] [--origin current --trigger "..." --kind waiting|blocker|curiosity|unknown]',
  },
  { paths: ["rebuild"], text: "tempad rebuild [--until <iso>]" },
  { paths: ["w5 enqueue"], text: "tempad w5 enqueue --session <id> [--forced]" },
  { paths: ["w5 context"], text: "tempad w5 context --session <id>" },
  { paths: ["w5 run"], text: "tempad w5 run [--detached]" },
  {
    paths: ["w5 hook", "w5 hook install", "w5 hook uninstall"],
    text: "tempad w5 hook install|uninstall [--scope user|project]",
  },
  {
    paths: ["w5 backfill"],
    text: "tempad w5 backfill [--days <n> | --from <iso>] [--model <name>] [--force]   (--from: classify sessions that ended at or after that time)",
  },
  { paths: ["w5 dedupe"], text: "tempad w5 dedupe [--dry-run]" },
  {
    paths: ["w5 eval"],
    text: "tempad w5 eval --from <date> --to <date> [--db <path>] [--declare <file>]",
  },
  { paths: ["quiet"], text: "tempad quiet <2h|30m>" },
  { paths: ["review"], text: "tempad review [--days <n>]" },
  {
    paths: ["scry"],
    text: "tempad scry [--json] [--days <n>] [--fast]   (read-only health check of the data: Health, Stats, Recommendations; exit 1 when a check fails; --fast skips quick_check and the projection replay)",
  },
  {
    paths: ["schedule", "schedule install"],
    text: "tempad schedule install   (write and load an hourly per-user `tempad sync`: a LaunchAgent on macOS, a systemd user timer on Linux; running it again rewrites and reloads; logs to TEMPAD_HOME/logs/sync.log)",
  },
  {
    paths: ["schedule remove"],
    text: "tempad schedule remove   (unload and delete the scheduled sync; fine when none is installed)",
  },
  {
    paths: ["schedule status"],
    text: "tempad schedule status [--json]   (installed, loaded, last run and its exit code; exit 1 unless installed, loaded and healthy)",
  },
  { paths: ["skill", "skill install"], text: "tempad skill install [--scope user|project]" },
  {
    paths: ["project register"],
    text: 'tempad project register <path> --name "<display>" [--org <org>] [--project <slug>]',
  },
  { paths: ["project list"], text: "tempad project list" },
  { paths: ["project reresolve"], text: "tempad project reresolve <path>" },
];

const HELP_SYNOPSIS = "tempad --help | -h | help [<command> [<subcommand> ...]] | --version";
const HELP_FOOTER = "Run tempad help <command> for one command.";

/** The usage text for one path (`tempad w5 backfill ...`). The `*_USAGE` constants build on it. */
export function usageText(path: string): string {
  const entry = USAGE_ENTRIES.find((candidate) => candidate.paths.includes(path));
  if (entry === undefined) throw new Error(`no usage text for "${path}"`);
  return entry.text;
}

/** `usage:` followed by every usage line of a command, for the group-level usage errors. */
export function commandUsageText(command: string): string {
  const lines = USAGE_ENTRIES.filter((entry) => commandOf(entry) === command).map(
    (entry) => entry.text,
  );
  if (lines.length === 0) throw new Error(`no usage text for "${command}"`);
  return lines.join("\nusage: ");
}

function commandOf(entry: UsageEntry): string {
  return (entry.paths[0] ?? "").split(" ")[0] ?? "";
}

function linesFor(entries: readonly UsageEntry[]): string[] {
  return entries.map((entry) => `  ${entry.text}`);
}

/** Every command's usage, in table order; what `tempad help` prints. */
export function globalUsage(): string[] {
  return ["Usage:", `  ${HELP_SYNOPSIS}`, ...linesFor(USAGE_ENTRIES)];
}

export function globalHelp(): string[] {
  return [...globalUsage(), "", HELP_FOOTER];
}

/** Whether `path` (`w5 hook`) is a node of the tree, a command or a nested path. */
function isTreePath(path: string[]): boolean {
  const [command, ...nested] = path;
  if (command === undefined || !Object.hasOwn(COMMAND_TREE, command)) return false;
  if (nested.length === 0) return true;
  const joined = nested.join(" ");
  return (COMMAND_TREE[command] ?? []).some((candidate) => candidate === joined);
}

/** The usage of one valid path: a command lists all of its lines, a nested path its own. */
export function usageForPath(path: string[]): string[] {
  const [command] = path;
  const joined = path.join(" ");
  if (path.length === 1) {
    const hits = USAGE_ENTRIES.filter(
      (entry) => commandOf(entry) === command || entry.paths.includes(joined),
    );
    return ["Usage:", ...linesFor(hits)];
  }
  return ["Usage:", ...linesFor(USAGE_ENTRIES.filter((entry) => entry.paths.includes(joined)))];
}

export type HelpResolution =
  | { ok: true; lines: string[] }
  | { ok: false; message: string; lines: string[] };

/**
 * Resolves `tempad help <tokens>` strictly: every token must be a known path part, so a
 * mistyped one is named in `message` and the nearest valid path's usage comes back with it.
 */
export function resolveHelp(rawTokens: string[]): HelpResolution {
  // `help w5 --help` asks for the same thing as `help w5`.
  const tokens = rawTokens.filter((token) => token !== "--help" && token !== "-h");
  if (tokens.length === 0) return { ok: true, lines: globalHelp() };
  const [command] = tokens;
  if (command === undefined || !isTreePath([command])) {
    return {
      ok: false,
      message: `tempad: unknown command "${command}"`,
      lines: globalUsage(),
    };
  }
  let valid = [command];
  for (const token of tokens.slice(1)) {
    const next = [...valid, token];
    if (!isTreePath(next) && !hasNestedPrefix(next)) {
      return {
        ok: false,
        message: `tempad: unknown subcommand "${token}" for tempad ${valid.join(" ")}`,
        lines: usageForPath(valid),
      };
    }
    valid = next;
  }
  if (!isTreePath(valid)) {
    return {
      ok: false,
      message: `tempad: "${valid.join(" ")}" needs a subcommand`,
      lines: usageForPath(valid.slice(0, 1)),
    };
  }
  return { ok: true, lines: usageForPath(valid) };
}

/** `w5 hook` is a path whose own children (`install`) are listed with the prefix `hook `. */
function hasNestedPrefix(path: string[]): boolean {
  const [command, ...nested] = path;
  if (command === undefined) return false;
  const joined = nested.join(" ");
  return (COMMAND_TREE[command] ?? []).some((candidate) => candidate.startsWith(`${joined} `));
}

export function isCommand(command: string | undefined): command is string {
  return command !== undefined && isTreePath([command]);
}

/** The next path tokens `COMMAND_TREE` allows after `path` (empty when `path` is a leaf). */
function childrenOf(path: string[]): Set<string> {
  const [command, ...nested] = path;
  const children = new Set<string>();
  if (command === undefined) return children;
  const prefix = nested.length === 0 ? "" : `${nested.join(" ")} `;
  for (const candidate of COMMAND_TREE[command] ?? []) {
    if (!candidate.startsWith(prefix)) continue;
    const next = candidate.slice(prefix.length).split(" ")[0];
    if (next) children.add(next);
  }
  return children;
}

export type WalkedPath = { ok: true; path: string[] } | Extract<HelpResolution, { ok: false }>;

/**
 * Walks the arguments after `command` down `COMMAND_TREE` until one is a flag or the path
 * reaches a leaf. Past a leaf the arguments are positionals and values (`quest merge <id>`,
 * `quiet 2h`, `scry`), left to the command. An argument that is not a child of a node that
 * has children is an unknown subcommand, at any depth (`w5 hook bogus`, `sync bogus`), so a
 * command missing from the table is unreachable rather than silently running.
 */
export function walkPath(command: string, args: string[]): WalkedPath {
  const path = [command];
  for (const argument of args) {
    if (argument.startsWith("-")) break;
    const children = childrenOf(path);
    if (children.size === 0) break;
    if (!children.has(argument)) {
      return {
        ok: false,
        message: `tempad: unknown subcommand "${argument}" for tempad ${path.join(" ")}`,
        lines: usageForPath(path),
      };
    }
    path.push(argument);
  }
  return { ok: true, path };
}

/**
 * How many positional arguments each runnable path takes after the path itself. `walkPath`
 * only catches an unknown word where a subcommand may stand, so this is what turns
 * `rebuild bogus`, `party list bogus` or `sync --full bogus` into a usage error. Every leaf of
 * `COMMAND_TREE` and `sync` (whose one positional is the source) needs an entry; a test walks
 * the table, so a new command cannot slip through.
 */
export const POSITIONAL_LIMITS: Readonly<Record<string, number>> = {
  "hero init": 1,
  "party add": 2,
  "party leave": 1,
  "party list": 0,
  "client add": 2,
  "saga add": 1,
  "saga reword": 2,
  "saga replace": 2,
  "saga end": 1,
  "saga edit": 2,
  "saga list": 0,
  "quest add": 1,
  "quest reword": 2,
  "quest replace": 2,
  "quest end": 1,
  "quest edit": 2,
  "quest confirm": 1,
  "quest merge": 1,
  "quest pause": 1,
  "quest resume": 1,
  "quest done": 1,
  "quest abandon": 1,
  "quest branch": 1,
  "quest return": 1,
  "quest retract": 1,
  "quest delete": 1,
  "quest declare": 0,
  "quest list": 0,
  "stint list": 0,
  "trace list": 0,
  "impact set": 2,
  "impact list": 0,
  "impact import": 1,
  answer: 1,
  rebuild: 0,
  setup: 0,
  init: 0,
  sync: 1,
  "sync monday": 0,
  "sync github": 0,
  "sync claude": 0,
  "report daily": 0,
  "report project": 0,
  "report hourly": 0,
  "report weekly": 0,
  "w5 enqueue": 0,
  "w5 context": 0,
  "w5 run": 0,
  "w5 hook install": 0,
  "w5 hook uninstall": 0,
  "w5 backfill": 0,
  "w5 dedupe": 0,
  "w5 eval": 0,
  quiet: 1,
  review: 0,
  scry: 0,
  "schedule install": 0,
  "schedule remove": 0,
  "schedule status": 0,
  "skill install": 0,
  "project register": 1,
  "project list": 0,
  "project reresolve": 1,
};

/** Flags that stand alone; every other flag takes the argument after it as its value. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--all",
  "--belongs",
  "--detached",
  "--dry-run",
  "--fast",
  "--force",
  "--forced",
  "--forget",
  "--full",
  "--json",
  "--no-verify",
  "--non-interactive",
  "--open",
  "--pull",
  "--push",
  "--side",
  "--unconfirmed",
]);

/** The positional arguments of `args`: what is left once flags and their values are skipped. */
function positionalsOf(args: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }
    if (!argument.includes("=") && !BOOLEAN_FLAGS.has(argument)) index += 1;
  }
  return positionals;
}

/**
 * The first positional of `args` past what `path` takes, as a usage error, or `null`. `args`
 * are the arguments after the command, including the words `walkPath` consumed for `path`.
 */
export function checkPositionals(path: string[], args: string[]): HelpResolution | null {
  const limit = POSITIONAL_LIMITS[path.join(" ")];
  if (limit === undefined) return null;
  const extra = positionalsOf(args)[path.length - 1 + limit];
  if (extra === undefined) return null;
  return {
    ok: false,
    message: `tempad: unexpected argument "${extra}" for tempad ${path.join(" ")}`,
    lines: usageForPath(path),
  };
}

/** Every path of `COMMAND_TREE` and every path a usage entry documents, for the drift test. */
export function documentedPaths(): { table: string[]; usage: string[] } {
  const table = Object.entries(COMMAND_TREE).flatMap(([command, nested]) => [
    command,
    ...nested.map((path) => `${command} ${path}`),
  ]);
  const usage = [...new Set(USAGE_ENTRIES.flatMap((entry) => entry.paths))];
  return { table, usage };
}
