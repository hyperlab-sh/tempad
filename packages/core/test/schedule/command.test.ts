import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHD_LABEL } from "../../src/schedule/definitions";
import {
  type CommandResult,
  type CommandRunner,
  probeSchedule,
  resolveInvokedEntry,
  resolveRuntime,
  runScheduleCommand,
  type ScheduleContext,
  schedulePaths,
} from "../../src/schedule/index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  home: string;
  tempadHome: string;
  runtime: string;
  script: string;
  environment: NodeJS.ProcessEnv;
}

/** A throwaway HOME with a configured tempad home, a runtime and an entry script that exist. */
function sandbox(
  options: { name?: string; explicitHome?: boolean; extra?: NodeJS.ProcessEnv } = {},
): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `tempad-schedule-${options.name ?? "test"}-`));
  roots.push(root);
  const home = join(root, "my home");
  const tempadHome = options.explicitHome ? join(root, "tempad data") : join(home, ".tempad");
  mkdirSync(tempadHome, { recursive: true });
  writeFileSync(join(tempadHome, ".env"), "");
  const toolDirectory = join(root, "tools");
  mkdirSync(toolDirectory, { recursive: true });
  const runtime = join(toolDirectory, "bun");
  const script = join(root, "checkout", "src", "cli.ts");
  mkdirSync(join(root, "checkout", "src"), { recursive: true });
  writeFileSync(runtime, "");
  writeFileSync(script, "");
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: "/usr/local/bin:./relative:/usr/bin::bin",
    ...(options.explicitHome ? { TEMPAD_HOME: tempadHome } : {}),
    ...options.extra,
  };
  return { root, home, tempadHome, runtime, script, environment };
}

interface Scripted {
  calls: string[];
  run: CommandRunner;
}

/** A runner that records `command args` and answers from `answers` (first prefix match), else exit 0. */
function runner(
  answers: Record<string, Partial<CommandResult> | Partial<CommandResult>[]> = {},
): Scripted {
  const calls: string[] = [];
  const counters = new Map<string, number>();
  return {
    calls,
    run(command, args) {
      const line = [command, ...args].join(" ");
      calls.push(line);
      const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
      let answer: Partial<CommandResult> = {};
      if (key !== undefined) {
        const entry = answers[key] as Partial<CommandResult> | Partial<CommandResult>[];
        if (Array.isArray(entry)) {
          const index = counters.get(key) ?? 0;
          counters.set(key, index + 1);
          answer = entry[Math.min(index, entry.length - 1)] as Partial<CommandResult>;
        } else answer = entry;
      }
      return { status: 0, stdout: "", stderr: "", ...answer };
    },
  };
}

interface Run {
  code: number;
  out: string[];
  err: string[];
}

function schedule(
  box: Sandbox,
  platform: NodeJS.Platform,
  args: string[],
  scripted: Scripted,
  overrides: Partial<ScheduleContext> = {},
): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runScheduleCommand(args, {
    platform,
    environment: box.environment,
    uid: 501,
    run: scripted.run,
    resolveEntry: () => ({ runtime: box.runtime, script: box.script }),
    sleep: () => {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  });
  return { code, out, err };
}

const plistPath = (box: Sandbox) =>
  join(box.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const unitDirectory = (box: Sandbox) => join(box.home, ".config", "systemd", "user");

const LAUNCHD_PRINT = `gui/501/sh.hyperlab.tempad.sync = {
\tactive count = 0
\tpath = /Users/me/Library/LaunchAgents/sh.hyperlab.tempad.sync.plist
\ttype = LaunchAgent
\tstate = not running

\tprogram = /opt/bun
\tdomain = gui/501 [100023]
\truns = 4
\tlast exit code = 0

\tsemaphores = {
\t}
}
`;

describe("install on macOS", () => {
  test("writes the plist, makes the log directory, then bootout, enable, bootstrap in that order", () => {
    const box = sandbox();
    const scripted = runner();
    const result = schedule(box, "darwin", ["install"], scripted);

    expect(result.code).toBe(0);
    expect(scripted.calls).toEqual([
      `launchctl bootout gui/501/${LAUNCHD_LABEL}`,
      `launchctl enable gui/501/${LAUNCHD_LABEL}`,
      `launchctl bootstrap gui/501 ${plistPath(box)}`,
    ]);
    const plist = readFileSync(plistPath(box), "utf8");
    expect(plist).toContain(`<string>${box.runtime}</string>`);
    expect(plist).toContain(`<string>${box.script}</string>`);
    expect(plist).toContain("<integer>3600</integer>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain(`<string>${join(box.tempadHome, "logs", "sync.log")}</string>`);
    expect(statSync(join(box.tempadHome, "logs")).isDirectory()).toBe(true);
    expect(result.out[0]).toBe(`installed ${plistPath(box)}`);
  });

  test("the home directory with a space reaches the plist unbroken", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    expect(box.home).toContain(" ");
    expect(readFileSync(plistPath(box), "utf8")).toContain(
      `<string>${join(box.home, ".tempad", "logs", "sync.log")}</string>`,
    );
  });

  test("TEMPAD_HOME is carried only when set, with `~` expanded against HOME", () => {
    const unset = sandbox();
    schedule(unset, "darwin", ["install"], runner());
    expect(readFileSync(plistPath(unset), "utf8")).not.toContain("TEMPAD_HOME");

    const explicit = sandbox({ explicitHome: true });
    schedule(explicit, "darwin", ["install"], runner());
    const plist = readFileSync(plistPath(explicit), "utf8");
    expect(plist).toContain(`<key>TEMPAD_HOME</key>\n    <string>${explicit.tempadHome}</string>`);
    expect(plist).toContain(`<string>${join(explicit.tempadHome, "logs", "sync.log")}</string>`);

    const tilde = sandbox({ extra: { TEMPAD_HOME: "~/data/tempad" } });
    mkdirSync(join(tilde.home, "data", "tempad"), { recursive: true });
    writeFileSync(join(tilde.home, "data", "tempad", ".env"), "");
    schedule(tilde, "darwin", ["install"], runner());
    expect(readFileSync(plistPath(tilde), "utf8")).toContain(
      `<string>${join(tilde.home, "data", "tempad")}</string>`,
    );
  });

  test("PATH starts with the runtime's directory, keeps absolute entries once, drops relative and empty ones", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    const path = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(
      readFileSync(plistPath(box), "utf8"),
    )?.[1];
    expect(path).toBe(`${join(box.root, "tools")}:/usr/local/bin:/usr/bin:/opt/homebrew/bin:/bin`);
  });

  test("installing twice rewrites the same plist and boots it out and in again", () => {
    const box = sandbox();
    const scripted = runner();
    schedule(box, "darwin", ["install"], scripted);
    const first = readFileSync(plistPath(box), "utf8");
    const second = schedule(box, "darwin", ["install"], scripted);

    expect(second.code).toBe(0);
    expect(readFileSync(plistPath(box), "utf8")).toBe(first);
    expect(scripted.calls.filter((call) => call.includes("bootout"))).toHaveLength(2);
    expect(scripted.calls.filter((call) => call.includes("bootstrap"))).toHaveLength(2);
  });

  test("a changed entry is what the second install writes", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    const other = join(box.root, "other", "cli.ts");
    mkdirSync(join(box.root, "other"));
    writeFileSync(other, "");
    schedule(box, "darwin", ["install"], runner(), {
      resolveEntry: () => ({ runtime: box.runtime, script: other }),
    });
    const plist = readFileSync(plistPath(box), "utf8");
    expect(plist).toContain(other);
    expect(plist).not.toContain(box.script);
  });

  test("a bootstrap that fails right after bootout is retried and then succeeds", () => {
    const box = sandbox();
    const scripted = runner({
      "launchctl bootstrap": [{ status: 5, stderr: "Bootstrap failed: 5: Input/output error" }, {}],
    });
    const result = schedule(box, "darwin", ["install"], scripted);
    expect(result.code).toBe(0);
    expect(scripted.calls.filter((call) => call.includes("bootstrap"))).toHaveLength(2);
  });

  test("a bootstrap that keeps failing exits 1 with launchctl's message after five attempts", () => {
    const box = sandbox();
    const scripted = runner({
      "launchctl bootstrap": { status: 5, stderr: "Bootstrap failed: 5\nmore" },
    });
    const result = schedule(box, "darwin", ["install"], scripted);
    expect(result.code).toBe(1);
    expect(scripted.calls.filter((call) => call.includes("bootstrap"))).toHaveLength(5);
    expect(result.err).toEqual([
      `schedule: wrote ${plistPath(box)} but launchctl bootstrap failed (exit 5: Bootstrap failed: 5)`,
    ]);
  });

  test("an unconfigured home is refused and nothing is written", () => {
    const box = sandbox();
    rmSync(join(box.tempadHome, ".env"));
    const scripted = runner();
    const result = schedule(box, "darwin", ["install"], scripted);
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain("tempad is not set up yet");
    expect(existsSync(plistPath(box))).toBe(false);
    expect(existsSync(join(box.tempadHome, "logs"))).toBe(false);
    expect(scripted.calls).toEqual([]);
  });

  test("an entry that cannot be pinned down exits 1 and writes nothing", () => {
    const box = sandbox();
    const result = schedule(box, "darwin", ["install"], runner(), {
      resolveEntry: () =>
        resolveInvokedEntry(["bun", join(box.root, "gone.ts")], box.runtime, () => false),
    });
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain("cannot resolve the tempad entry");
    expect(existsSync(plistPath(box))).toBe(false);
  });

  test("without a user id there is nothing to bootstrap into", () => {
    const box = sandbox();
    const result = schedule(box, "darwin", ["install"], runner(), { uid: null });
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain("needs a user id");
  });

  test("HOME missing or relative is an error, not a write to the working directory", () => {
    const box = sandbox();
    box.environment.HOME = "relative/home";
    const result = schedule(box, "darwin", ["install"], runner());
    expect(result.code).toBe(1);
    expect(result.err[0]).toBe("schedule: HOME is not set to an absolute path");
  });
});

describe("install on Linux", () => {
  test("writes service and timer under ~/.config/systemd/user, reloads, enables --now", () => {
    const box = sandbox();
    const scripted = runner();
    const result = schedule(box, "linux", ["install"], scripted);

    expect(result.code).toBe(0);
    expect(scripted.calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now tempad-sync.timer",
    ]);
    const service = readFileSync(join(unitDirectory(box), "tempad-sync.service"), "utf8");
    expect(service).toContain(`ExecStart=${box.runtime} --no-env-file ${box.script} sync`);
    expect(service).toContain(`StandardOutput=append:${join(box.tempadHome, "logs", "sync.log")}`);
    const timer = readFileSync(join(unitDirectory(box), "tempad-sync.timer"), "utf8");
    expect(timer).toContain("OnCalendar=hourly");
    expect(timer).not.toContain("OnUnitActiveSec");
    expect(timer).toContain("Persistent=true");
    expect(result.out.join("\n")).toContain("loginctl enable-linger");
  });

  test("XDG_CONFIG_HOME wins when absolute and is ignored when relative", () => {
    const absolute = sandbox();
    absolute.environment.XDG_CONFIG_HOME = join(absolute.root, "xdg config");
    schedule(absolute, "linux", ["install"], runner());
    expect(
      existsSync(join(absolute.root, "xdg config", "systemd", "user", "tempad-sync.timer")),
    ).toBe(true);

    const relative = sandbox();
    relative.environment.XDG_CONFIG_HOME = "xdg";
    schedule(relative, "linux", ["install"], runner());
    expect(existsSync(join(unitDirectory(relative), "tempad-sync.timer"))).toBe(true);
  });

  test("a home with a space is quoted in ExecStart and the environment", () => {
    const box = sandbox({ explicitHome: true });
    box.environment.PATH = "/usr/bin";
    schedule(box, "linux", ["install"], runner(), {
      resolveEntry: () => ({
        runtime: box.runtime,
        script: join(box.root, "checkout", "src", "cli.ts"),
      }),
    });
    const service = readFileSync(join(unitDirectory(box), "tempad-sync.service"), "utf8");
    expect(service).toContain(`Environment="TEMPAD_HOME=${box.tempadHome}"`);
    expect(box.tempadHome).toContain(" ");
    expect(service).toContain(`WorkingDirectory=${box.tempadHome}\n`);
  });

  test("a second install also restarts the timer so the new schedule applies", () => {
    const box = sandbox();
    const scripted = runner();
    schedule(box, "linux", ["install"], scripted);
    scripted.calls.length = 0;
    const second = schedule(box, "linux", ["install"], scripted);
    expect(second.code).toBe(0);
    expect(scripted.calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now tempad-sync.timer",
      "systemctl --user restart tempad-sync.timer",
    ]);
  });

  test("a failing systemctl step exits 1 naming the command and stops there", () => {
    const box = sandbox();
    const scripted = runner({
      "systemctl --user enable": { status: 1, stderr: "Failed to connect to bus: No medium found" },
    });
    const result = schedule(box, "linux", ["install"], scripted);
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain("`systemctl --user enable --now tempad-sync.timer` failed");
    expect(result.err[0]).toContain("Failed to connect to bus");
  });

  test("a missing systemctl (exit 127) is reported", () => {
    const box = sandbox();
    const result = schedule(
      box,
      "linux",
      ["install"],
      runner({ systemctl: { status: 127, stderr: "spawn systemctl ENOENT" } }),
    );
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain("exit 127: spawn systemctl ENOENT");
  });
});

describe("unsupported platforms and usage", () => {
  test("win32 exits 1 with a clear error for every action and runs nothing", () => {
    const box = sandbox();
    for (const action of ["install", "remove", "status"]) {
      const scripted = runner();
      const result = schedule(box, "win32", [action], scripted);
      expect(result.code).toBe(1);
      expect(result.err).toEqual([
        "schedule: tempad schedule supports macOS (launchd) and Linux (systemd --user); win32 is not supported",
      ]);
      expect(scripted.calls).toEqual([]);
    }
  });

  test("a missing or unknown action, extra words and --json outside status are usage errors (exit 2)", () => {
    const box = sandbox();
    for (const args of [
      [],
      ["bogus"],
      ["install", "now"],
      ["install", "--json"],
      ["remove", "--json"],
      ["status", "--bogus"],
    ]) {
      const scripted = runner();
      const result = schedule(box, "darwin", args, scripted);
      expect(result.code).toBe(2);
      expect(result.err.at(-1)).toContain("usage: tempad schedule install");
      expect(scripted.calls).toEqual([]);
    }
    expect(existsSync(plistPath(box))).toBe(false);
  });
});

describe("remove", () => {
  test("macOS: boots the job out and deletes the plist", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    const scripted = runner();
    const result = schedule(box, "darwin", ["remove"], scripted);
    expect(result.code).toBe(0);
    expect(scripted.calls).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
    expect(existsSync(plistPath(box))).toBe(false);
    expect(result.out).toEqual([`removed ${plistPath(box)}`]);
  });

  test("macOS: removing when nothing is installed or loaded is fine", () => {
    const box = sandbox();
    const scripted = runner({
      "launchctl bootout": { status: 113, stderr: "Could not find service" },
    });
    const result = schedule(box, "darwin", ["remove"], scripted);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["no schedule installed; nothing to remove"]);
  });

  test("macOS: a job still loaded after its plist was deleted by hand is still booted out", () => {
    const box = sandbox();
    const result = schedule(box, "darwin", ["remove"], runner());
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["removed the loaded job (its plist was already gone)"]);
  });

  test("macOS: remove twice leaves the second a no-op", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    schedule(box, "darwin", ["remove"], runner());
    const again = schedule(
      box,
      "darwin",
      ["remove"],
      runner({ "launchctl bootout": { status: 113 } }),
    );
    expect(again.code).toBe(0);
    expect(again.out).toEqual(["no schedule installed; nothing to remove"]);
  });

  test("Linux: disables the timer, stops the service, deletes both files, reloads", () => {
    const box = sandbox();
    schedule(box, "linux", ["install"], runner());
    const scripted = runner();
    const result = schedule(box, "linux", ["remove"], scripted);
    expect(result.code).toBe(0);
    expect(scripted.calls).toEqual([
      "systemctl --user disable --now tempad-sync.timer",
      "systemctl --user stop tempad-sync.service",
      "systemctl --user daemon-reload",
    ]);
    expect(existsSync(join(unitDirectory(box), "tempad-sync.service"))).toBe(false);
    expect(existsSync(join(unitDirectory(box), "tempad-sync.timer"))).toBe(false);
  });

  test("Linux: removing when absent exits 0 and does not reload", () => {
    const box = sandbox();
    const scripted = runner({ "systemctl --user disable": { status: 1 } });
    const result = schedule(box, "linux", ["remove"], scripted);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["no schedule installed; nothing to remove"]);
    expect(scripted.calls).not.toContain("systemctl --user daemon-reload");
  });

  test("remove works on a home that was never set up", () => {
    const box = sandbox();
    rmSync(join(box.tempadHome, ".env"));
    expect(schedule(box, "darwin", ["remove"], runner()).code).toBe(0);
  });
});

describe("status on macOS", () => {
  test("installed, loaded, last exit 0: exit 0, parsed fields, log time as last run", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    const log = join(box.tempadHome, "logs", "sync.log");
    writeFileSync(log, "monday: inserted=0\n");
    utimesSync(log, new Date("2026-10-17T09:00:00Z"), new Date("2026-10-17T09:00:00Z"));

    const scripted = runner({ "launchctl print": { stdout: LAUNCHD_PRINT } });
    const result = schedule(box, "darwin", ["status", "--json"], scripted);
    expect(scripted.calls).toEqual([`launchctl print gui/501/${LAUNCHD_LABEL}`]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      manager: "launchd",
      name: LAUNCHD_LABEL,
      installed: true,
      loaded: true,
      state: "not running",
      lastExitCode: 0,
      lastRunAt: "2026-10-17T09:00:00.000Z",
      lastRunSource: "log",
      nextRunAt: null,
      intervalSeconds: 3600,
      definition: [plistPath(box)],
      command: [box.runtime, "--no-env-file", box.script, "sync"],
      logPath: log,
      problems: [],
    });
  });

  test("plain output names installed, loaded, the command, the log and the last run", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    const result = schedule(
      box,
      "darwin",
      ["status"],
      runner({ "launchctl print": { stdout: LAUNCHD_PRINT } }),
    );
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(text).toContain(`schedule: installed, loaded (launchd ${LAUNCHD_LABEL})`);
    expect(text).toContain(`runs: ${box.runtime} --no-env-file ${box.script} sync (every hour)`);
    expect(text).toContain("state: not running");
    expect(text).toContain(`log: ${join(box.tempadHome, "logs", "sync.log")}`);
  });

  test("a last exit code other than 0 is a problem and exits 1", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    const result = schedule(
      box,
      "darwin",
      ["status", "--json"],
      runner({
        "launchctl print": {
          stdout: LAUNCHD_PRINT.replace("last exit code = 0", "last exit code = 1"),
        },
      }),
    );
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.out.join("\n"));
    expect(parsed.lastExitCode).toBe(1);
    expect(parsed.problems).toEqual([
      `the last run exited 1; see ${join(box.tempadHome, "logs", "sync.log")}`,
    ]);
  });

  test("a job that has never exited has no exit code, and no runs means no last run", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    const never = LAUNCHD_PRINT.replace(
      "last exit code = 0",
      "last exit code = (never exited)",
    ).replace("runs = 4", "runs = 0");
    const result = schedule(
      box,
      "darwin",
      ["status", "--json"],
      runner({ "launchctl print": { stdout: never } }),
    );
    const parsed = JSON.parse(result.out.join("\n"));
    expect(parsed.lastExitCode).toBeNull();
    expect(parsed.lastRunAt).toBeNull();
    expect(result.code).toBe(0);
  });

  test("installed but not loaded exits 1 and says how to fix it", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    const result = schedule(
      box,
      "darwin",
      ["status"],
      runner({ "launchctl print": { status: 113, stderr: "Could not find service" } }),
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toContain("schedule: installed, not loaded");
    expect(result.out.join("\n")).toContain("problem: installed but not loaded");
  });

  test("not installed: exit 1, one line pointing at install", () => {
    const box = sandbox();
    const result = schedule(
      box,
      "darwin",
      ["status"],
      runner({ "launchctl print": { status: 113 } }),
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toBe(
      `schedule: not installed, not loaded (launchd ${LAUNCHD_LABEL})\nrun \`tempad schedule install\` to collect every hour`,
    );
  });

  test("a runtime or entry that no longer exists is a problem even while loaded", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    rmSync(box.script);
    const result = schedule(
      box,
      "darwin",
      ["status", "--json"],
      runner({ "launchctl print": { stdout: LAUNCHD_PRINT } }),
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n")).problems).toEqual([
      `${box.script} is missing, so the job fails; run \`tempad schedule install\` again`,
    ]);
  });

  test("launchctl missing: load state unknown, not a crash", () => {
    const box = sandbox();
    schedule(box, "darwin", ["install"], runner());
    const result = schedule(
      box,
      "darwin",
      ["status", "--json"],
      runner({ "launchctl print": { status: 127, stderr: "ENOENT" } }),
    );
    const parsed = JSON.parse(result.out.join("\n"));
    expect(parsed.loaded).toBeNull();
    expect(parsed.problems[0]).toContain("launchctl not found");
    expect(result.code).toBe(1);
  });
});

describe("status on Linux", () => {
  const TIMER_SHOW =
    "ActiveState=active\nSubState=waiting\nNextElapseUSecRealtime=Sat 2026-10-17 11:00:00 UTC\nLastTriggerUSec=Sat 2026-10-17 10:00:01 UTC\n";
  const SERVICE_SHOW =
    "ExecMainStatus=0\nExecMainExitTimestamp=Sat 2026-10-17 10:00:09 UTC\nResult=success\n";

  test("active timer, last run and next run parsed from systemctl show", () => {
    const box = sandbox();
    schedule(box, "linux", ["install"], runner());
    const scripted = runner({
      "systemctl --user show tempad-sync.timer": { stdout: TIMER_SHOW },
      "systemctl --user show tempad-sync.service": { stdout: SERVICE_SHOW },
    });
    const result = schedule(box, "linux", ["status", "--json"], scripted);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n"));
    expect(parsed).toMatchObject({
      manager: "systemd",
      name: "tempad-sync.timer",
      installed: true,
      loaded: true,
      state: "active/waiting",
      lastExitCode: 0,
      lastRunSource: "systemd",
      command: [box.runtime, "--no-env-file", box.script, "sync"],
      problems: [],
    });
    expect(parsed.lastRunAt).toBe(new Date("2026-10-17T10:00:09").toISOString());
    expect(parsed.nextRunAt).toBe(new Date("2026-10-17T11:00:00").toISOString());
  });

  test("a failed last run exits 1; before the first run (no exit timestamp) the status 0 is not reported", () => {
    const box = sandbox();
    schedule(box, "linux", ["install"], runner());
    const failed = schedule(
      box,
      "linux",
      ["status", "--json"],
      runner({
        "systemctl --user show tempad-sync.timer": { stdout: TIMER_SHOW },
        "systemctl --user show tempad-sync.service": {
          stdout: SERVICE_SHOW.replace("ExecMainStatus=0", "ExecMainStatus=1"),
        },
      }),
    );
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out.join("\n")).lastExitCode).toBe(1);

    const fresh = schedule(
      box,
      "linux",
      ["status", "--json"],
      runner({
        "systemctl --user show tempad-sync.timer": {
          stdout:
            "ActiveState=active\nSubState=waiting\nNextElapseUSecRealtime=n/a\nLastTriggerUSec=n/a\n",
        },
        "systemctl --user show tempad-sync.service": {
          stdout: "ExecMainStatus=0\nExecMainExitTimestamp=\nResult=success\n",
        },
      }),
    );
    const parsed = JSON.parse(fresh.out.join("\n"));
    expect(parsed.lastExitCode).toBeNull();
    expect(parsed.lastRunAt).toBeNull();
    expect(parsed.nextRunAt).toBeNull();
    expect(fresh.code).toBe(0);
  });

  test("an inactive timer with files in place exits 1", () => {
    const box = sandbox();
    schedule(box, "linux", ["install"], runner());
    const result = schedule(
      box,
      "linux",
      ["status", "--json"],
      runner({ "systemctl --user show": { stdout: "ActiveState=inactive\nSubState=dead\n" } }),
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ installed: true, loaded: false });
  });

  test("systemctl --user unreachable: load state unknown with the reason, exit 1", () => {
    const box = sandbox();
    schedule(box, "linux", ["install"], runner());
    const result = schedule(
      box,
      "linux",
      ["status", "--json"],
      runner({ "systemctl --user show": { status: 1, stderr: "Failed to connect to bus" } }),
    );
    const parsed = JSON.parse(result.out.join("\n"));
    expect(parsed.loaded).toBeNull();
    expect(parsed.problems[0]).toContain(
      "systemctl --user is unavailable (exit 1: Failed to connect to bus)",
    );
    expect(result.code).toBe(1);
  });

  test("only one of the two files present counts as not installed", () => {
    const box = sandbox();
    schedule(box, "linux", ["install"], runner());
    rmSync(join(unitDirectory(box), "tempad-sync.timer"));
    const result = schedule(
      box,
      "linux",
      ["status", "--json"],
      runner({ "systemctl --user show": { stdout: "ActiveState=inactive\n" } }),
    );
    expect(JSON.parse(result.out.join("\n")).installed).toBe(false);
  });
});

describe("probeSchedule and schedulePaths", () => {
  test("the probe reads the filesystem only and reports installed once the definition exists", () => {
    const box = sandbox();
    expect(probeSchedule("darwin", box.environment)).toEqual({
      manager: "launchd",
      installed: false,
      logPath: join(box.tempadHome, "logs", "sync.log"),
    });
    schedule(box, "darwin", ["install"], runner());
    expect(probeSchedule("darwin", box.environment)?.installed).toBe(true);
    expect(probeSchedule("linux", box.environment)?.installed).toBe(false);
  });

  test("Linux needs both unit files", () => {
    const box = sandbox();
    schedule(box, "linux", ["install"], runner());
    expect(probeSchedule("linux", box.environment)?.installed).toBe(true);
    rmSync(join(unitDirectory(box), "tempad-sync.service"));
    expect(probeSchedule("linux", box.environment)?.installed).toBe(false);
  });

  test("an unsupported platform or an unusable HOME gives no probe", () => {
    const box = sandbox();
    expect(probeSchedule("win32", box.environment)).toBeNull();
    expect(probeSchedule("darwin", { ...box.environment, HOME: undefined })).toBeNull();
    expect(schedulePaths("freebsd", box.environment)).toBeNull();
  });
});

describe("resolveInvokedEntry", () => {
  test("resolves a symlinked bin to the real script, like ~/.local/bin/tempad -> .../src/cli.ts", () => {
    const box = sandbox();
    const link = join(box.root, "bin", "tempad");
    mkdirSync(join(box.root, "bin"));
    symlinkSync(box.script, link);
    const entry = resolveInvokedEntry(["bun", link], box.runtime, () => false, noBunOnPath(box));
    expect(entry).toEqual({
      runtime: box.runtime,
      script: join(statRealpath(box.script)),
      warnings: [],
    });
  });

  test("refuses a copy under the temp directory or the bunx cache, naming the fix", () => {
    const box = sandbox();
    expect(() => resolveInvokedEntry(["bun", box.script], box.runtime)).toThrow(
      "install it first with `bun add -g @hyperlab.sh/tempad`",
    );
  });

  test("a missing argv entry, a directory and a non-script are errors", () => {
    const box = sandbox();
    expect(() => resolveInvokedEntry(["bun"], box.runtime, () => false, noBunOnPath(box))).toThrow(
      "cannot tell which tempad",
    );
    expect(() =>
      resolveInvokedEntry(["bun", box.root], box.runtime, () => false, noBunOnPath(box)),
    ).toThrow("not a script");
    const text = join(box.root, "notes.txt");
    writeFileSync(text, "");
    expect(() =>
      resolveInvokedEntry(["bun", text], box.runtime, () => false, noBunOnPath(box)),
    ).toThrow("not a script");
  });
});

function noBunOnPath(box: Sandbox): NodeJS.ProcessEnv {
  return { HOME: box.home, PATH: "" };
}

function statRealpath(path: string): string {
  return realpathSync(path);
}

describe("the Bun the job runs", () => {
  /** A directory on PATH holding an executable `bun`. */
  function bunIn(directory: string): string {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "bun");
    writeFileSync(path, "");
    return path;
  }

  test("a bun from a stable directory on PATH wins over the versioned execPath", () => {
    const box = sandbox();
    const shim = bunIn(join(box.home, ".proto", "shims"));
    const versioned = join(box.home, ".proto", "tools", "bun", "1.4.2", "bun");
    const resolved = resolveRuntime(
      { HOME: box.home, PATH: `/nonexistent:${join(box.home, ".proto", "shims")}:/usr/bin` },
      versioned,
      () => false,
    );
    expect(resolved).toEqual({ runtime: shim, warning: null });
  });

  test.each([[".bun/bin"], [".proto/shims"]])("~/%s counts as stable", (relative) => {
    const box = sandbox();
    const bun = bunIn(join(box.home, relative));
    expect(
      resolveRuntime(
        { HOME: box.home, PATH: join(box.home, relative) },
        "/x/1.4.2/bun",
        () => false,
      ).runtime,
    ).toBe(bun);
  });

  test("the first bun on PATH decides: an unstable one earlier falls back to execPath, with a warning for a versioned path", () => {
    const box = sandbox();
    bunIn(join(box.root, "node_modules", ".bin"));
    bunIn(join(box.home, ".bun", "bin"));
    const versioned = "/opt/tools/bun/1.4.2/bun";
    const resolved = resolveRuntime(
      {
        HOME: box.home,
        PATH: `${join(box.root, "node_modules", ".bin")}:${join(box.home, ".bun", "bin")}`,
      },
      versioned,
      () => false,
    );
    expect(resolved.runtime).toBe(versioned);
    expect(resolved.warning).toContain(`pins ${versioned}`);
    expect(resolved.warning).toContain("breaks when that Bun is upgraded away");
  });

  test("an execPath without a version in its path falls back quietly", () => {
    const box = sandbox();
    expect(resolveRuntime({ HOME: box.home, PATH: "" }, "/opt/custom/bun", () => false)).toEqual({
      runtime: "/opt/custom/bun",
      warning: null,
    });
  });

  test("a relative PATH entry is never used, even holding a bun", () => {
    const box = sandbox();
    const resolved = resolveRuntime(
      { HOME: box.home, PATH: "./bin:bin" },
      "/opt/custom/bun",
      () => false,
    );
    expect(resolved.runtime).toBe("/opt/custom/bun");
  });

  test("a disposable fallback Bun is refused", () => {
    const box = sandbox();
    expect(() =>
      resolveRuntime({ HOME: box.home, PATH: "" }, "/tmp/x/bun", (path) => path.startsWith("/tmp")),
    ).toThrow("disposable Bun");
  });

  test("install prints the runtime warning on stderr and still installs", () => {
    const box = sandbox();
    const result = schedule(box, "darwin", ["install"], runner(), {
      resolveEntry: () => ({
        runtime: box.runtime,
        script: box.script,
        warnings: ["the job pins /x/1.4.2/bun"],
      }),
    });
    expect(result.code).toBe(0);
    expect(result.err).toEqual(["warning: the job pins /x/1.4.2/bun"]);
  });
});

describe("install warnings and TEMPAD_HOME", () => {
  test("a needed variable set in the shell but missing from .env is warned about, by name, never by value", () => {
    const box = sandbox({
      extra: { MONDAY_API_TOKEN: "secret-value", GH_TOKEN: "other-secret", TZ: "UTC" },
    });
    writeFileSync(join(box.tempadHome, ".env"), "MONDAY_USER=1\n");
    const result = schedule(box, "darwin", ["install"], runner());
    expect(result.code).toBe(0);
    expect(result.err).toEqual([
      `warning: MONDAY_API_TOKEN, GH_TOKEN are set in this shell but not in ${join(box.tempadHome, ".env")}; the scheduled job does not see shell exports, so add them there`,
    ]);
    expect(result.err.join("")).not.toContain("secret-value");
  });

  test("variables already in .env, and shell variables sync never reads, stay quiet", () => {
    const box = sandbox({ extra: { MONDAY_USER: "1", TZ: "UTC", SOMETHING_ELSE: "x" } });
    writeFileSync(join(box.tempadHome, ".env"), "MONDAY_USER=1\n");
    expect(schedule(box, "darwin", ["install"], runner()).err).toEqual([]);
  });

  test("a single variable reads in the singular", () => {
    const box = sandbox({ extra: { HOST_SLUG: "mac" } });
    const result = schedule(box, "darwin", ["install"], runner());
    expect(result.err[0]).toContain("HOST_SLUG is set in this shell");
    expect(result.err[0]).toContain("so add it there");
  });

  test("a relative TEMPAD_HOME is made absolute in the plist, working directory and log path", () => {
    const box = sandbox({ extra: { TEMPAD_HOME: "rel-home" } });
    const absolute = join(process.cwd(), "rel-home");
    mkdirSync(absolute, { recursive: true });
    try {
      writeFileSync(join(absolute, ".env"), "");
      const result = schedule(box, "darwin", ["install"], runner());
      expect(result.code).toBe(0);
      const plist = readFileSync(plistPath(box), "utf8");
      expect(plist).toContain(`<key>TEMPAD_HOME</key>\n    <string>${absolute}</string>`);
      expect(plist).toContain(`<string>${join(absolute, "logs", "sync.log")}</string>`);
      expect(plist).not.toContain("<string>rel-home");
    } finally {
      rmSync(absolute, { recursive: true, force: true });
    }
  });
});
