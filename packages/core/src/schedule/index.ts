import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { collectors } from "../collect/index.ts";
import { ENV_VARS, readDotEnv } from "../config/env.ts";
import { commandUsageText } from "../usage.ts";
import { isUnstableInstallPath } from "../w5/hooks.ts";
import {
  LAUNCHD_LABEL,
  parseLaunchdCommand,
  parseSystemdCommand,
  renderLaunchdPlist,
  renderSystemdService,
  renderSystemdTimer,
  type ScheduleJob,
  SYNC_INTERVAL_SECONDS,
  SYSTEMD_UNIT,
} from "./definitions.ts";

export const SCHEDULE_USAGE = `usage: ${commandUsageText("schedule")}`;

/** Where the tool dirs a scheduled job needs usually live, appended after the caller's own `PATH`. */
const FALLBACK_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const BOOTSTRAP_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_MS = 500;

/** Anything the operator can fix; printed as one line, exit 1. */
export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

export interface CommandResult {
  /** Exit status; 127 when the program does not exist, null when it died on a signal. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `launchctl`/`systemctl`. Injected, so tests never reach the real service manager. */
export type CommandRunner = (command: string, args: string[]) => CommandResult;

export const runCommand: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  if (result.error !== undefined) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    return { status: missing ? 127 : null, stdout: "", stderr: result.error.message };
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export interface ResolvedEntry {
  runtime: string;
  script: string;
  /** Things the operator should know about the choice; printed by `install`. */
  warnings?: string[];
}

export interface ScheduleContext {
  platform: NodeJS.Platform;
  /** Read for `HOME`, `XDG_CONFIG_HOME`, `TEMPAD_HOME` and `PATH`; never `os.homedir()`, which a test cannot redirect. */
  environment: NodeJS.ProcessEnv;
  /** The user id for `gui/<uid>`; null where there is none. */
  uid: number | null;
  run: CommandRunner;
  /** The tempad the user invoked: runtime and entry script. Throws `ScheduleError` when it cannot be pinned down. */
  resolveEntry: () => ResolvedEntry;
  sleep: (milliseconds: number) => void;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Directories whose `bun` survives a Bun upgrade: the proto shim directory, bun's own bin and the
 * package managers' prefixes. A binary under `~/.proto/tools/bun/<version>/` does not.
 */
function stableRuntimeDirectories(home: string): string[] {
  return [
    join(home, ".proto", "shims"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/**
 * The Bun the job runs. `process.execPath` is the binary in use, but under proto or a version
 * manager it is `~/.proto/tools/bun/1.4.2/bun`, which the next upgrade deletes. So prefer the
 * `bun` the caller's `PATH` finds in a stable directory. Two entries are skipped, not trusted:
 * the directory of `execPath` itself, and anything under `~/.proto/tools/` (the proto shim
 * prepends its versioned tool directory to `PATH` before it execs bun, so inside bun that
 * directory comes before `~/.proto/shims`). Under proto with nothing stable on `PATH`,
 * `$PROTO_HOME/shims/bun` (default `~/.proto/shims/bun`) is checked directly. The first `bun`
 * found in any other, unstable directory (`node_modules/.bin`) decides for the fallback. Through
 * a shim the version comes from proto's resolution in the job's working directory
 * (`TEMPAD_HOME`), that is proto's global default, not the checkout's `.prototools` pin.
 * Otherwise `execPath`, with a warning when its path carries a version.
 */
export function resolveRuntime(
  environment: NodeJS.ProcessEnv,
  execPath: string,
  isUnstable: (path: string) => boolean,
): { runtime: string; warning: string | null } {
  const home = environment.HOME ?? "";
  const trim = (path: string) => path.replace(/\/+$/, "");
  const stable = stableRuntimeDirectories(home).map(trim);
  const protoHome = trim(environment.PROTO_HOME || join(home, ".proto"));
  const versionedRoots = [join(home, ".proto", "tools"), join(protoHome, "tools")].map(trim);
  const skipped = new Set([trim(dirname(execPath))]);
  const isVersioned = (entry: string) =>
    versionedRoots.some((root) => entry === root || entry.startsWith(`${root}/`));

  for (const entry of (environment.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(entry) || skipped.has(trim(entry)) || isVersioned(trim(entry))) continue;
    const candidate = join(entry, "bun");
    if (!existsSync(candidate)) continue;
    if (stable.includes(trim(entry))) return { runtime: candidate, warning: null };
    break;
  }
  if (isVersioned(trim(dirname(execPath)))) {
    const shim = join(protoHome, "shims", "bun");
    if (existsSync(shim)) return { runtime: shim, warning: null };
  }
  if (isUnstable(execPath)) {
    throw new ScheduleError(
      `${execPath} is a disposable Bun (a temp directory or a cache); run \`tempad schedule install\` with a Bun installed in ~/.bun/bin, ~/.proto/shims, /opt/homebrew/bin or /usr/local/bin`,
    );
  }
  const versioned = /\/\d+\.\d+\.\d+(\/|$)/.test(execPath);
  return {
    runtime: execPath,
    warning: versioned
      ? `the job pins ${execPath}, which has a version in its path and breaks when that Bun is upgraded away; put bun on PATH in ~/.bun/bin or ~/.proto/shims, or run \`tempad schedule install\` again after an upgrade`
      : null,
  };
}

/**
 * The tempad the user invoked: a stable Bun (`resolveRuntime`) and the real path of its entry
 * script (`argv[1]` with symlinks resolved, so `~/.local/bin/tempad -> .../src/cli.ts` and a
 * global install both land on the `cli.ts` that actually runs). Refuses a copy that sits where bun
 * clears things (the `bunx` cache, the temp directory): the job would break once it is gone.
 */
export function resolveInvokedEntry(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
  isUnstable: (path: string) => boolean = isUnstableInstallPath,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedEntry {
  const invoked = argv[1];
  if (invoked === undefined) throw new ScheduleError("cannot tell which tempad is running");
  let script: string;
  try {
    script = realpathSync(invoked);
  } catch {
    throw new ScheduleError(`cannot resolve the tempad entry ${invoked}`);
  }
  if (!statSync(script).isFile() || !/\.[cm]?[jt]s$/.test(script)) {
    throw new ScheduleError(`the tempad entry ${script} is not a script bun can run`);
  }
  if (isUnstable(script)) {
    throw new ScheduleError(
      `${script} is a disposable copy of tempad (the bunx cache or a temp directory); install it first with \`bun add -g @hyperlab.sh/tempad\` and run \`tempad schedule install\` from there`,
    );
  }
  const { runtime, warning } = resolveRuntime(environment, execPath, isUnstable);
  return { runtime, script, warnings: warning === null ? [] : [warning] };
}

function homeOf(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME;
  if (!home || !isAbsolute(home)) throw new ScheduleError("HOME is not set to an absolute path");
  return home;
}

/**
 * `TEMPAD_HOME` as the CLI resolves it (a leading `~` expanded), or the default under `HOME`. A
 * relative value is made absolute against the current directory: the job starts somewhere else.
 */
function tempadHomeOf(environment: NodeJS.ProcessEnv): { path: string; explicit: boolean } {
  const home = homeOf(environment);
  const configured = environment.TEMPAD_HOME;
  if (!configured) return { path: join(home, ".tempad"), explicit: false };
  const expanded =
    configured === "~"
      ? home
      : configured.startsWith("~/")
        ? join(home, configured.slice(2))
        : configured;
  return { path: resolve(expanded), explicit: true };
}

export function syncLogPath(environment: NodeJS.ProcessEnv): string {
  return join(tempadHomeOf(environment).path, "logs", "sync.log");
}

export interface SchedulePaths {
  manager: "launchd" | "systemd";
  /** The definition files, in the order they are written. */
  files: string[];
}

/** Where the definition lives; null on a platform with no supported scheduler. */
export function schedulePaths(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): SchedulePaths | null {
  if (platform === "darwin") {
    return {
      manager: "launchd",
      files: [join(homeOf(environment), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)],
    };
  }
  if (platform === "linux") {
    // The XDG spec ignores a relative `XDG_CONFIG_HOME`.
    const configured = environment.XDG_CONFIG_HOME;
    const base =
      configured && isAbsolute(configured) ? configured : join(homeOf(environment), ".config");
    const directory = join(base, "systemd", "user");
    return {
      manager: "systemd",
      files: [join(directory, `${SYSTEMD_UNIT}.service`), join(directory, `${SYSTEMD_UNIT}.timer`)],
    };
  }
  return null;
}

/** What `tempad scry` needs to know: is there a scheduler here, and is a definition installed. */
export interface ScheduleProbe {
  manager: "launchd" | "systemd";
  installed: boolean;
  logPath: string;
}

/** Reads the filesystem only (no `launchctl`, no `systemctl`); null when the platform is unsupported or `HOME` unusable. */
export function probeSchedule(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ScheduleProbe | null {
  try {
    const paths = schedulePaths(platform, environment);
    if (paths === null) return null;
    return {
      manager: paths.manager,
      installed: paths.files.every((file) => existsSync(file)),
      logPath: syncLogPath(environment),
    };
  } catch (error) {
    if (error instanceof ScheduleError) return null;
    throw error;
  }
}

/** Absolute entries only (a relative one would resolve against the job's directory), deduplicated. */
function jobPath(runtime: string, environment: NodeJS.ProcessEnv): string {
  const entries = [
    dirname(runtime),
    ...(environment.PATH ?? "").split(delimiter),
    ...FALLBACK_PATH,
  ];
  return [...new Set(entries.filter((entry) => entry !== "" && isAbsolute(entry)))].join(delimiter);
}

/**
 * Variables the scheduled job needs that are set in this shell but missing from `TEMPAD_HOME/.env`:
 * the job inherits nothing from the shell, so `sync` would fail or skip a source there. Only the
 * ones the collectors (and push sync) read are checked, and only when set, so a clean shell is quiet.
 */
function shellOnlyVariables(environment: NodeJS.ProcessEnv, home: string): string[] {
  const keys = new Set<string>(["ghToken", "syncToken", "hostSlug"]);
  for (const collector of collectors.values()) for (const key of collector.needs) keys.add(key);
  const fileValues = readDotEnv(home);
  return ENV_VARS.filter((variable) => keys.has(variable.key))
    .map((variable) => variable.name)
    .filter((name) => (environment[name] ?? "") !== "" && fileValues[name] === undefined);
}

function buildJob(context: ScheduleContext): { job: ScheduleJob; warnings: string[] } {
  const { runtime, script, warnings = [] } = context.resolveEntry();
  const home = tempadHomeOf(context.environment);
  const shellOnly = shellOnlyVariables(context.environment, home.path);
  const allWarnings = [...warnings];
  if (shellOnly.length > 0) {
    allWarnings.push(
      `${shellOnly.join(", ")} ${shellOnly.length === 1 ? "is" : "are"} set in this shell but not in ${join(home.path, ".env")}; the scheduled job does not see shell exports, so add ${shellOnly.length === 1 ? "it" : "them"} there`,
    );
  }
  return {
    job: {
      // `--no-env-file` is the CLI shebang's flag; a job started as `bun <script>` has to pass it itself.
      command: [runtime, "--no-env-file", script, "sync"],
      path: jobPath(runtime, context.environment),
      tempadHome: home.explicit ? home.path : null,
      workingDirectory: home.path,
      logPath: syncLogPath(context.environment),
    },
    warnings: allWarnings,
  };
}

function describeFailure(result: CommandResult): string {
  const text = (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "";
  return `exit ${result.status ?? "signal"}${text === "" ? "" : `: ${text}`}`;
}

function writeDefinition(path: string, content: string): boolean {
  const existed = existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o644 });
  return existed;
}

function removeFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function serviceTarget(context: ScheduleContext): string {
  if (context.uid === null)
    throw new ScheduleError("launchd needs a user id, and there is none here");
  return `gui/${context.uid}`;
}

function describeJob(job: ScheduleJob, lines: string[]): void {
  lines.push(`runs: ${job.command.join(" ")}`);
  lines.push(`log: ${job.logPath}`);
}

// --- install ---------------------------------------------------------------

function installLaunchd(
  context: ScheduleContext,
  paths: SchedulePaths,
  job: ScheduleJob,
): string[] {
  const plist = paths.files[0] as string;
  const domain = serviceTarget(context);
  writeDefinition(plist, renderLaunchdPlist(job));
  // A loaded job keeps the definition it was loaded with; unload it so the new one is read.
  // `enable` clears a `launchctl disable` the user once ran, which makes `bootstrap` fail.
  context.run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
  context.run("launchctl", ["enable", `${domain}/${LAUNCHD_LABEL}`]);
  let result = context.run("launchctl", ["bootstrap", domain, plist]);
  // `bootout` returns before launchd has finished with the old job; a bootstrap right after it can fail with I/O error 5.
  for (let attempt = 1; result.status !== 0 && attempt < BOOTSTRAP_ATTEMPTS; attempt += 1) {
    context.sleep(BOOTSTRAP_RETRY_MS);
    result = context.run("launchctl", ["bootstrap", domain, plist]);
  }
  if (result.status !== 0) {
    throw new ScheduleError(
      `wrote ${plist} but launchctl bootstrap failed (${describeFailure(result)})`,
    );
  }
  const lines = [`installed ${plist}`, `loaded ${LAUNCHD_LABEL}: runs now, then every hour`];
  describeJob(job, lines);
  return lines;
}

function installSystemd(
  context: ScheduleContext,
  paths: SchedulePaths,
  job: ScheduleJob,
): string[] {
  const [servicePath, timerPath] = paths.files as [string, string];
  const reinstall = existsSync(timerPath);
  writeDefinition(servicePath, renderSystemdService(job));
  writeDefinition(timerPath, renderSystemdTimer());
  const timer = `${SYSTEMD_UNIT}.timer`;
  const steps: string[][] = [
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", timer],
    // `enable --now` leaves a running timer on the schedule it was started with.
    ...(reinstall ? [["--user", "restart", timer]] : []),
    // The timer fires on the hour; this is the first run now (launchd's `RunAtLoad`). `--no-block`
    // because a oneshot `start` would wait for the whole sync.
    ["--user", "start", "--no-block", `${SYSTEMD_UNIT}.service`],
  ];
  for (const args of steps) {
    const result = context.run("systemctl", args);
    if (result.status !== 0) {
      throw new ScheduleError(
        `wrote ${servicePath} and ${timerPath} but \`systemctl ${args.join(" ")}\` failed (${describeFailure(result)})`,
      );
    }
  }
  const lines = [
    `installed ${servicePath} and ${timerPath}`,
    `enabled ${timer}: first run started now, then every hour on the hour`,
  ];
  describeJob(job, lines);
  lines.push(
    "note: a user timer only runs while you are logged in; `loginctl enable-linger` keeps it running after logout",
  );
  return lines;
}

// --- remove ----------------------------------------------------------------

function removeLaunchd(context: ScheduleContext, paths: SchedulePaths): string[] {
  const plist = paths.files[0] as string;
  const unloaded = context.run("launchctl", [
    "bootout",
    `${serviceTarget(context)}/${LAUNCHD_LABEL}`,
  ]);
  const deleted = removeFile(plist);
  if (!deleted && unloaded.status !== 0) return ["no schedule installed; nothing to remove"];
  return [`removed ${deleted ? plist : "the loaded job (its plist was already gone)"}`];
}

function removeSystemd(context: ScheduleContext, paths: SchedulePaths): string[] {
  const existed = paths.files.some((file) => existsSync(file));
  const timer = `${SYSTEMD_UNIT}.timer`;
  context.run("systemctl", ["--user", "disable", "--now", timer]);
  context.run("systemctl", ["--user", "stop", `${SYSTEMD_UNIT}.service`]);
  const removed = paths.files.filter((file) => removeFile(file));
  if (existed) context.run("systemctl", ["--user", "daemon-reload"]);
  if (removed.length === 0) return ["no schedule installed; nothing to remove"];
  return [`removed ${removed.join(" and ")}`];
}

// --- status ----------------------------------------------------------------

export interface ScheduleStatus {
  manager: "launchd" | "systemd";
  /** `sh.hyperlab.tempad.sync` or `tempad-sync.timer`. */
  name: string;
  installed: boolean;
  /** Whether the manager has it loaded and active; null when the manager could not be asked. */
  loaded: boolean | null;
  /** The manager's own word for it: launchd `state`, systemd `ActiveState/SubState`. */
  state: string | null;
  /** Exit code of the last run, from launchctl or systemctl; null when it has not run or is unknown. */
  lastExitCode: number | null;
  lastRunAt: string | null;
  /** `launchd` has no timestamp, so the log's modification time stands in for it. */
  lastRunSource: "systemd" | "log" | null;
  nextRunAt: string | null;
  intervalSeconds: number;
  definition: string[];
  command: string[] | null;
  logPath: string;
  /** Things to fix: a missing runtime or entry, a failed last run, an unreachable manager. */
  problems: string[];
}

/** `systemctl show` prints `Key=Value`; a timestamp there is local time, `n/a` or empty when unset. */
function parseShow(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return values;
}

function parseSystemdTimestamp(value: string | undefined): string | null {
  const match = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value ?? "");
  if (match === null) return null;
  const parsed = new Date(`${match[1]}T${match[2]}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function logModifiedAt(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function commandProblems(command: string[] | null): string[] {
  if (command === null) return ["the installed definition has no command"];
  // runtime, `--no-env-file`, entry script, `sync`: the two paths are what a move or an upgrade breaks.
  return [command[0], command[2]]
    .filter((path): path is string => path !== undefined && isAbsolute(path))
    .filter((path) => !existsSync(path))
    .map((path) => `${path} is missing, so the job fails; run \`tempad schedule install\` again`);
}

function statusLaunchd(context: ScheduleContext, paths: SchedulePaths): ScheduleStatus {
  const plist = paths.files[0] as string;
  const text = readIfPresent(plist);
  const logPath = syncLogPath(context.environment);
  const status: ScheduleStatus = {
    manager: "launchd",
    name: LAUNCHD_LABEL,
    installed: text !== null,
    loaded: null,
    state: null,
    lastExitCode: null,
    lastRunAt: null,
    lastRunSource: null,
    nextRunAt: null,
    intervalSeconds: SYNC_INTERVAL_SECONDS,
    definition: paths.files,
    command: text === null ? null : parseLaunchdCommand(text),
    logPath,
    problems: text === null ? [] : commandProblems(parseLaunchdCommand(text)),
  };
  const printed = context.run("launchctl", ["print", `${serviceTarget(context)}/${LAUNCHD_LABEL}`]);
  if (printed.status === 0) {
    status.loaded = true;
    status.state = /^\s*state = (.+)$/m.exec(printed.stdout)?.[1]?.trim() ?? null;
    const exit = /^\s*last exit code = (-?\d+)\s*$/m.exec(printed.stdout)?.[1];
    status.lastExitCode = exit === undefined ? null : Number.parseInt(exit, 10);
    const runs = /^\s*runs = (\d+)\s*$/m.exec(printed.stdout)?.[1];
    if (runs !== undefined && Number.parseInt(runs, 10) > 0) {
      status.lastRunAt = logModifiedAt(logPath);
      status.lastRunSource = status.lastRunAt === null ? null : "log";
    }
  } else if (printed.status === 127) {
    status.problems.push("launchctl not found; cannot tell whether the job is loaded");
  } else {
    status.loaded = false;
    if (status.installed) {
      status.problems.push("installed but not loaded; run `tempad schedule install` to load it");
    }
  }
  if (status.lastExitCode !== null && status.lastExitCode !== 0) {
    status.problems.push(`the last run exited ${status.lastExitCode}; see ${logPath}`);
  }
  return status;
}

function statusSystemd(context: ScheduleContext, paths: SchedulePaths): ScheduleStatus {
  const [servicePath, timerPath] = paths.files as [string, string];
  const serviceText = readIfPresent(servicePath);
  const timerText = readIfPresent(timerPath);
  const command = serviceText === null ? null : parseSystemdCommand(serviceText);
  const status: ScheduleStatus = {
    manager: "systemd",
    name: `${SYSTEMD_UNIT}.timer`,
    installed: serviceText !== null && timerText !== null,
    loaded: null,
    state: null,
    lastExitCode: null,
    lastRunAt: null,
    lastRunSource: null,
    nextRunAt: null,
    intervalSeconds: SYNC_INTERVAL_SECONDS,
    definition: paths.files,
    command,
    logPath: syncLogPath(context.environment),
    problems: serviceText === null ? [] : commandProblems(command),
  };
  const timer = context.run("systemctl", [
    "--user",
    "show",
    `${SYSTEMD_UNIT}.timer`,
    "-p",
    "ActiveState",
    "-p",
    "SubState",
    "-p",
    "NextElapseUSecRealtime",
    "-p",
    "LastTriggerUSec",
  ]);
  if (timer.status !== 0) {
    status.problems.push(`systemctl --user is unavailable (${describeFailure(timer)})`);
    return status;
  }
  const timerValues = parseShow(timer.stdout);
  const activeState = timerValues.get("ActiveState");
  status.loaded = activeState === "active";
  status.state = [activeState, timerValues.get("SubState")].filter(Boolean).join("/") || null;
  status.nextRunAt = parseSystemdTimestamp(timerValues.get("NextElapseUSecRealtime"));
  if (status.installed && !status.loaded) {
    status.problems.push("installed but the timer is not active; run `tempad schedule install`");
  }

  const service = context.run("systemctl", [
    "--user",
    "show",
    `${SYSTEMD_UNIT}.service`,
    "-p",
    "ExecMainStatus",
    "-p",
    "ExecMainExitTimestamp",
    "-p",
    "Result",
  ]);
  if (service.status === 0) {
    const values = parseShow(service.stdout);
    const exitTime = parseSystemdTimestamp(values.get("ExecMainExitTimestamp"));
    status.lastRunAt = exitTime ?? parseSystemdTimestamp(timerValues.get("LastTriggerUSec"));
    status.lastRunSource = status.lastRunAt === null ? null : "systemd";
    // ExecMainStatus is 0 before the first run too; only a timestamp says the service has run.
    if (exitTime !== null) {
      const code = Number.parseInt(values.get("ExecMainStatus") ?? "", 10);
      status.lastExitCode = Number.isNaN(code) ? null : code;
    }
    if (status.lastExitCode !== null && status.lastExitCode !== 0) {
      status.problems.push(`the last run exited ${status.lastExitCode}; see ${status.logPath}`);
    }
  }
  return status;
}

function formatStatus(status: ScheduleStatus): string[] {
  const lines = [
    `schedule: ${status.installed ? "installed" : "not installed"}, ${
      status.loaded === null ? "load state unknown" : status.loaded ? "loaded" : "not loaded"
    } (${status.manager} ${status.name})`,
  ];
  if (!status.installed && status.loaded !== true) {
    lines.push("run `tempad schedule install` to collect every hour");
    return lines;
  }
  lines.push(`definition: ${status.definition.join(" and ")}`);
  if (status.command !== null) lines.push(`runs: ${status.command.join(" ")} (every hour)`);
  if (status.state !== null) lines.push(`state: ${status.state}`);
  lines.push(
    status.lastRunAt === null
      ? "last run: none yet"
      : `last run: ${status.lastRunAt}${status.lastRunSource === "log" ? " (the log was last written)" : ""}${
          status.lastExitCode === null ? "" : `, exit code ${status.lastExitCode}`
        }`,
  );
  if (status.nextRunAt !== null) lines.push(`next run: ${status.nextRunAt}`);
  lines.push(`log: ${status.logPath}`);
  for (const problem of status.problems) lines.push(`problem: ${problem}`);
  return lines;
}

// --- command ---------------------------------------------------------------

export function defaultScheduleContext(): ScheduleContext {
  return {
    platform: process.platform,
    environment: process.env,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    run: runCommand,
    resolveEntry: () => resolveInvokedEntry(),
    sleep: sleepSync,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

/**
 * `tempad schedule install | remove | status [--json]`. Exit 0 on success (`status`: installed,
 * loaded and nothing to fix), 1 for something the operator can fix or a `status` that found a
 * problem, 2 for a usage error.
 */
export function runScheduleCommand(
  args: string[],
  overrides: Partial<ScheduleContext> = {},
): number {
  const context = { ...defaultScheduleContext(), ...overrides };
  let parsed: ReturnType<typeof parseScheduleArguments>;
  try {
    parsed = parseScheduleArguments(args);
  } catch (error) {
    context.stderr(
      `schedule: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
    );
    context.stderr(SCHEDULE_USAGE);
    return 2;
  }
  const [action, ...extra] = parsed.positionals;
  if (
    (action !== "install" && action !== "remove" && action !== "status") ||
    extra.length > 0 ||
    (parsed.values.json && action !== "status")
  ) {
    context.stderr(SCHEDULE_USAGE);
    return 2;
  }

  try {
    const paths = schedulePaths(context.platform, context.environment);
    if (paths === null) {
      throw new ScheduleError(
        `tempad schedule supports macOS (launchd) and Linux (systemd --user); ${context.platform} is not supported`,
      );
    }
    if (action === "install") {
      const home = tempadHomeOf(context.environment).path;
      if (!existsSync(join(home, ".env")) && !existsSync(join(home, "tempad.db"))) {
        throw new ScheduleError(
          `tempad is not set up yet (${home}); run /tempad:setup in Claude Code, or \`tempad setup\` in a terminal, before scheduling a sync`,
        );
      }
      const { job, warnings } = buildJob(context);
      for (const warning of warnings) context.stderr(`warning: ${warning}`);
      mkdirSync(dirname(job.logPath), { recursive: true, mode: 0o700 });
      const lines =
        paths.manager === "launchd"
          ? installLaunchd(context, paths, job)
          : installSystemd(context, paths, job);
      for (const line of lines) context.stdout(line);
      return 0;
    }
    if (action === "remove") {
      const lines =
        paths.manager === "launchd" ? removeLaunchd(context, paths) : removeSystemd(context, paths);
      for (const line of lines) context.stdout(line);
      return 0;
    }
    const status =
      paths.manager === "launchd" ? statusLaunchd(context, paths) : statusSystemd(context, paths);
    context.stdout(
      parsed.values.json ? JSON.stringify(status, null, 2) : formatStatus(status).join("\n"),
    );
    return status.installed && status.loaded === true && status.problems.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof ScheduleError)) throw error;
    context.stderr(`schedule: ${error.message}`);
    return 1;
  }
}

function parseScheduleArguments(args: string[]) {
  return parseArgs({
    args,
    options: { json: { type: "boolean", default: false } },
    strict: true,
    allowPositionals: true,
  });
}
