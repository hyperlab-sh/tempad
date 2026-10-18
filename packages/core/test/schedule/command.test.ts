import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import { dirname, join } from "node:path";
import { LAUNCHD_LABEL } from "../../src/schedule/definitions";
import {
  type CommandResult,
  type CommandRunner,
  probeSchedule,
  readBunPin,
  resolveInvokedEntry,
  resolveRuntime,
  runCommand,
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
      "systemctl --user start --no-block tempad-sync.service",
    ]);
    const service = readFileSync(join(unitDirectory(box), "tempad-sync.service"), "utf8");
    expect(service).toContain(`ExecStart=${box.runtime} --no-env-file ${box.script} sync`);
    expect(service).toContain(`StandardOutput=append:${join(box.tempadHome, "logs", "sync.log")}`);
    const timer = readFileSync(join(unitDirectory(box), "tempad-sync.timer"), "utf8");
    expect(timer).toContain("OnCalendar=hourly");
    expect(timer).not.toContain("OnUnitActiveSec");
    // The first run is the explicit start; a second trigger at activation would run two syncs.
    expect(timer).not.toContain("OnActiveSec");
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
      "systemctl --user start --no-block tempad-sync.service",
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
    expect(scripted.calls).toEqual([
      `${box.runtime} --version`,
      `launchctl print gui/501/${LAUNCHD_LABEL}`,
    ]);
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
      bunVersion: null,
      bunPinned: null,
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
      bunPin: null,
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

describe("the Bun the job runs under proto", () => {
  function bunIn(directory: string): string {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "bun");
    writeFileSync(path, "");
    return path;
  }

  test("inside bun the shim has put ~/.proto/tools/bun/<v> ahead of ~/.proto/shims: the tools dir is skipped, the shim wins", () => {
    const box = sandbox();
    const tools = join(box.home, ".proto", "tools", "bun", "1.4.2");
    const versioned = bunIn(tools);
    const shim = bunIn(join(box.home, ".proto", "shims"));
    const resolved = resolveRuntime(
      { HOME: box.home, PATH: `${tools}:${join(box.home, ".proto", "shims")}:/usr/bin` },
      versioned,
      () => false,
    );
    expect(resolved).toEqual({ runtime: shim, warning: null });
  });

  test("skipping the tools directory lets a later stable entry win over the shim fallback", () => {
    const box = sandbox();
    const tools = join(box.home, ".proto", "tools", "bun", "1.4.2");
    const versioned = bunIn(tools);
    bunIn(join(box.home, ".proto", "shims"));
    const bunBin = bunIn(join(box.home, ".bun", "bin"));
    expect(
      resolveRuntime(
        { HOME: box.home, PATH: `${tools}:${join(box.home, ".bun", "bin")}` },
        versioned,
        () => false,
      ).runtime,
    ).toBe(bunBin);
  });

  test("any ~/.proto/tools entry is skipped, not only the one execPath lives in", () => {
    const box = sandbox();
    const otherVersion = join(box.home, ".proto", "tools", "bun", "1.3.14");
    bunIn(otherVersion);
    const bunBin = bunIn(join(box.home, ".bun", "bin"));
    expect(
      resolveRuntime(
        { HOME: box.home, PATH: `${otherVersion}:${join(box.home, ".bun", "bin")}` },
        "/opt/custom/bun",
        () => false,
      ).runtime,
    ).toBe(bunBin);
  });

  test("the directory execPath lives in is skipped, so a later stable entry wins over it", () => {
    const box = sandbox();
    const dir = join(box.root, "elsewhere");
    const exec = bunIn(dir);
    const bunBin = bunIn(join(box.home, ".bun", "bin"));
    expect(
      resolveRuntime(
        { HOME: box.home, PATH: `${dir}:${join(box.home, ".bun", "bin")}` },
        exec,
        () => false,
      ).runtime,
    ).toBe(bunBin);
  });

  test("a PATH with the tools directory and nothing stable falls back to $PROTO_HOME/shims/bun, default ~/.proto/shims", () => {
    const box = sandbox();
    const tools = join(box.home, ".proto", "tools", "bun", "1.4.2");
    const versioned = bunIn(tools);
    const shim = bunIn(join(box.home, ".proto", "shims"));
    expect(resolveRuntime({ HOME: box.home, PATH: tools }, versioned, () => false).runtime).toBe(
      shim,
    );

    const custom = join(box.root, "proto home");
    const customTools = join(custom, "tools", "bun", "1.4.2");
    const customVersioned = bunIn(customTools);
    const customShim = bunIn(join(custom, "shims"));
    expect(
      resolveRuntime(
        { HOME: box.home, PROTO_HOME: custom, PATH: customTools },
        customVersioned,
        () => false,
      ).runtime,
    ).toBe(customShim);
  });

  test("no shim and nothing stable: the versioned execPath with its warning", () => {
    const box = sandbox();
    const tools = join(box.home, ".proto", "tools", "bun", "1.4.2");
    const versioned = bunIn(tools);
    const resolved = resolveRuntime({ HOME: box.home, PATH: tools }, versioned, () => false);
    expect(resolved.runtime).toBe(versioned);
    expect(resolved.warning).toContain("breaks when that Bun is upgraded away");
  });

  test("the directory execPath lives in is skipped even when it is not a versioned one", () => {
    const box = sandbox();
    const dir = join(box.root, "elsewhere");
    const exec = bunIn(dir);
    const resolved = resolveRuntime({ HOME: box.home, PATH: `${dir}:/usr/bin` }, exec, () => false);
    expect(resolved).toEqual({ runtime: exec, warning: null });
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

describe("the Bun version a scheduled job runs", () => {
  /** Writes a `.prototools` with the given body. */
  function prototools(directory: string, body: string): string {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, ".prototools");
    writeFileSync(path, body);
    return path;
  }

  describe("readBunPin", () => {
    test("reads bun from the nearest .prototools above the script, not a hardcoded version", () => {
      const box = sandbox();
      const source = prototools(join(box.root, "checkout"), 'bun = "1.7.3"\ngo = "1.26.6"\n');
      expect(readBunPin(box.script)).toEqual({ version: "1.7.3", source });
    });

    test("a nearer file with a pin overrides one further up; one without a bun key lets the search continue", () => {
      const box = sandbox();
      prototools(box.root, 'bun = "1.0.0"\n');
      expect(readBunPin(box.script)?.version).toBe("1.0.0");
      const nearer = prototools(join(box.root, "checkout"), 'go = "1.26.6"\n');
      expect(readBunPin(box.script)?.version).toBe("1.0.0");
      writeFileSync(nearer, 'bun = "1.2.3"\n');
      expect(readBunPin(box.script)?.version).toBe("1.2.3");
    });

    test("no .prototools, a malformed one, and a non-string bun pin nothing", () => {
      const box = sandbox();
      expect(readBunPin(box.script)).toBeNull();
      const file = prototools(join(box.root, "checkout"), "bun = = 1");
      expect(readBunPin(box.script)).toBeNull();
      writeFileSync(file, "bun = 1\n");
      expect(readBunPin(box.script)).toBeNull();
      writeFileSync(file, 'bun = " "\n');
      expect(readBunPin(box.script)).toBeNull();
    });

    test("the pin passes through as written, so a range or alias reaches proto unchanged", () => {
      const box = sandbox();
      prototools(join(box.root, "checkout"), 'bun = "1.4"\n');
      expect(readBunPin(box.script)?.version).toBe("1.4");
    });
  });

  describe("resolveInvokedEntry reads the pin only for the proto shim", () => {
    function shimBox(pin: string | null, installed: string[] = []) {
      const box = sandbox();
      const shims = join(box.home, ".proto", "shims");
      mkdirSync(shims, { recursive: true });
      writeFileSync(join(shims, "bun"), "");
      for (const version of installed) {
        mkdirSync(join(box.home, ".proto", "tools", "bun", version), { recursive: true });
      }
      const source =
        pin === null ? null : prototools(join(box.root, "checkout"), `bun = "${pin}"\n`);
      const environment = { HOME: box.home, PATH: shims };
      return { box, shim: join(shims, "bun"), source, environment };
    }

    test("a shim runtime with a pinned checkout carries the pin", () => {
      const { box, shim, source, environment } = shimBox("1.4.2", ["1.4.2"]);
      const entry = resolveInvokedEntry(["bun", box.script], "/x/bun", () => false, environment);
      expect(entry).toEqual({
        runtime: shim,
        script: realpathSync(box.script),
        // the entry is resolved through symlinks first (macOS's /var is /private/var), and so is the pin's file
        bunPin: {
          version: "1.4.2",
          source: join(realpathSync(dirname(source as string)), ".prototools"),
        },
        warnings: [],
      });
    });

    test("a pinned version proto has not installed is a warning naming the fix, install still goes ahead", () => {
      const { box, environment } = shimBox("1.4.2", ["1.3.14"]);
      const entry = resolveInvokedEntry(["bun", box.script], "/x/bun", () => false, environment);
      expect(entry.bunPin?.version).toBe("1.4.2");
      expect(entry.warnings).toHaveLength(1);
      expect(entry.warnings?.[0]).toContain("pins Bun 1.4.2, which proto has not installed");
      expect(entry.warnings?.[0]).toContain("proto install bun 1.4.2");
    });

    test("a range or alias is not checked against the installed directories", () => {
      const { box, environment } = shimBox("1.4", []);
      const entry = resolveInvokedEntry(["bun", box.script], "/x/bun", () => false, environment);
      expect(entry.bunPin?.version).toBe("1.4");
      expect(entry.warnings).toEqual([]);
    });

    test("a shim with no pin above the script carries none: proto's default stays in charge", () => {
      const { box, environment } = shimBox(null);
      const entry = resolveInvokedEntry(["bun", box.script], "/x/bun", () => false, environment);
      expect(entry.bunPin).toBeNull();
    });

    test("PROTO_HOME relocates both the shim and the installed-version check", () => {
      const box = sandbox();
      const protoHome = join(box.root, "elsewhere");
      const tools = join(protoHome, "tools", "bun", "1.4.2");
      mkdirSync(join(protoHome, "shims"), { recursive: true });
      writeFileSync(join(protoHome, "shims", "bun"), "");
      mkdirSync(tools, { recursive: true });
      writeFileSync(join(tools, "bun"), "");
      prototools(join(box.root, "checkout"), 'bun = "1.4.2"\n');
      // Run by the versioned binary, as under the shim: resolveRuntime falls back to $PROTO_HOME/shims/bun.
      const entry = resolveInvokedEntry(["bun", box.script], join(tools, "bun"), () => false, {
        HOME: box.home,
        PROTO_HOME: protoHome,
        PATH: tools,
      });
      expect(entry.runtime).toBe(join(protoHome, "shims", "bun"));
      expect(entry.bunPin?.version).toBe("1.4.2");
      expect(entry.warnings).toEqual([]);
    });

    test("a runtime that is not the shim ignores the pin: PROTO_BUN_VERSION would do nothing for it", () => {
      const box = sandbox();
      prototools(join(box.root, "checkout"), 'bun = "1.4.2"\n');
      const entry = resolveInvokedEntry(
        ["bun", box.script],
        box.runtime,
        () => false,
        noBunOnPath(box),
      );
      expect(entry.runtime).toBe(box.runtime);
      expect(entry.bunPin).toBeNull();
    });
  });

  describe("install carries the pin into the definition", () => {
    const pin = { version: "1.4.2", source: "/work/tempad/.prototools" };

    test("macOS: PROTO_BUN_VERSION is in the plist's environment and install says where it came from", () => {
      const box = sandbox();
      const result = schedule(box, "darwin", ["install"], runner(), {
        resolveEntry: () => ({ runtime: box.runtime, script: box.script, bunPin: pin }),
      });
      expect(result.code).toBe(0);
      const plist = readFileSync(plistPath(box), "utf8");
      expect(plist).toContain("<key>PROTO_BUN_VERSION</key>\n    <string>1.4.2</string>");
      expect(result.out.join("\n")).toContain(
        "bun: 1.4.2, pinned in /work/tempad/.prototools and carried as PROTO_BUN_VERSION",
      );
    });

    test("Linux: PROTO_BUN_VERSION is an Environment= line of the service", () => {
      const box = sandbox();
      schedule(box, "linux", ["install"], runner(), {
        resolveEntry: () => ({ runtime: box.runtime, script: box.script, bunPin: pin }),
      });
      const service = readFileSync(join(unitDirectory(box), "tempad-sync.service"), "utf8");
      expect(service).toContain('Environment="PROTO_BUN_VERSION=1.4.2"');
    });

    test("without a pin nothing about proto is written", () => {
      const box = sandbox();
      const result = schedule(box, "darwin", ["install"], runner());
      expect(readFileSync(plistPath(box), "utf8")).not.toContain("PROTO_BUN_VERSION");
      expect(result.out.join("\n")).not.toContain("PROTO_BUN_VERSION");
      schedule(box, "linux", ["install"], runner());
      expect(readFileSync(join(unitDirectory(box), "tempad-sync.service"), "utf8")).not.toContain(
        "PROTO_BUN_VERSION",
      );
    });

    test("reinstalling after the pin moved replaces the old version", () => {
      const box = sandbox();
      const first = { version: "1.3.14", source: "/a/.prototools" };
      schedule(box, "darwin", ["install"], runner(), {
        resolveEntry: () => ({ runtime: box.runtime, script: box.script, bunPin: first }),
      });
      schedule(box, "darwin", ["install"], runner(), {
        resolveEntry: () => ({ runtime: box.runtime, script: box.script, bunPin: pin }),
      });
      const plist = readFileSync(plistPath(box), "utf8");
      expect(plist).toContain("<string>1.4.2</string>");
      expect(plist).not.toContain("1.3.14");
    });
  });

  describe("status shows the version the job will use", () => {
    const pin = { version: "1.4.2", source: "/work/tempad/.prototools" };

    /** Records the options each command ran with; answers `--version` calls from `bun`. */
    function recording(
      bun: Partial<CommandResult>,
      answers: Record<string, Partial<CommandResult>> = {},
    ) {
      const options: { command: string; env?: NodeJS.ProcessEnv; cwd?: string }[] = [];
      const base = runner(answers);
      const run: CommandRunner = (command, args, option) => {
        if (args[0] === "--version") {
          options.push({ command, env: option?.env, cwd: option?.cwd });
          return { status: 0, stdout: "", stderr: "", ...bun };
        }
        return base.run(command, args, option);
      };
      return { run, options };
    }

    test("asks the job's runtime for --version with the job's environment and working directory, and never lets proto install", () => {
      const box = sandbox({ explicitHome: true });
      schedule(box, "darwin", ["install"], runner(), {
        resolveEntry: () => ({ runtime: box.runtime, script: box.script, bunPin: pin }),
      });
      const asked = recording(
        { stdout: "1.4.2\n" },
        { "launchctl print": { stdout: LAUNCHD_PRINT } },
      );
      const result = schedule(box, "darwin", ["status", "--json"], { calls: [], run: asked.run });
      expect(result.code).toBe(0);
      expect(asked.options).toHaveLength(1);
      const [call] = asked.options;
      expect(call?.command).toBe(box.runtime);
      expect(call?.cwd).toBe(box.tempadHome);
      expect(call?.env).toMatchObject({
        HOME: box.home,
        TEMPAD_HOME: box.tempadHome,
        PROTO_BUN_VERSION: "1.4.2",
        PROTO_AUTO_INSTALL: "false",
      });
      expect(call?.env?.PATH).toBe(readPath(readFileSync(plistPath(box), "utf8")));
      expect(JSON.parse(result.out.join("\n"))).toMatchObject({
        bunVersion: "1.4.2",
        bunPinned: "1.4.2",
      });
    });

    function readPath(plist: string): string | undefined {
      return /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
    }

    test("plain output: pinned, unpinned proto shim, and a plain binary", () => {
      const box = sandbox();
      const shims = join(box.home, ".proto", "shims");
      mkdirSync(shims, { recursive: true });
      const shim = join(shims, "bun");
      writeFileSync(shim, "");

      schedule(box, "darwin", ["install"], runner(), {
        resolveEntry: () => ({ runtime: shim, script: box.script, bunPin: pin }),
      });
      const printed = { "launchctl print": { stdout: LAUNCHD_PRINT } };
      const pinned = schedule(box, "darwin", ["status"], {
        calls: [],
        run: recording({ stdout: "1.4.2\n" }, printed).run,
      });
      expect(pinned.out.join("\n")).toContain("bun: 1.4.2 (pinned by PROTO_BUN_VERSION=1.4.2)");

      schedule(box, "darwin", ["install"], runner(), {
        resolveEntry: () => ({ runtime: shim, script: box.script }),
      });
      const unpinned = schedule(box, "darwin", ["status"], {
        calls: [],
        run: recording({ stdout: "1.3.14\n" }, printed).run,
      });
      expect(unpinned.out.join("\n")).toContain(
        "bun: 1.3.14 (proto shim, no pin: proto's default decides)",
      );

      schedule(box, "darwin", ["install"], runner());
      const plain = schedule(box, "darwin", ["status"], {
        calls: [],
        run: recording({ stdout: "1.4.2\n" }, printed).run,
      });
      expect(plain.out.join("\n")).toContain("bun: 1.4.2\n");
    });

    test("Linux reads the pin back from the service's Environment= lines", () => {
      const box = sandbox();
      schedule(box, "linux", ["install"], runner(), {
        resolveEntry: () => ({ runtime: box.runtime, script: box.script, bunPin: pin }),
      });
      const asked = recording(
        { stdout: "1.4.2\n" },
        {
          "systemctl --user show tempad-sync.timer": {
            stdout: "ActiveState=active\nSubState=waiting\n",
          },
        },
      );
      const result = schedule(box, "linux", ["status", "--json"], { calls: [], run: asked.run });
      expect(asked.options[0]?.env).toMatchObject({ PROTO_BUN_VERSION: "1.4.2" });
      expect(JSON.parse(result.out.join("\n"))).toMatchObject({
        bunVersion: "1.4.2",
        bunPinned: "1.4.2",
      });
    });

    test("a pinned Bun proto cannot start is a problem with proto's own message, and exits 1", () => {
      const box = sandbox();
      schedule(box, "darwin", ["install"], runner(), {
        resolveEntry: () => ({ runtime: box.runtime, script: box.script, bunPin: pin }),
      });
      const failing = recording(
        {
          status: 1,
          stderr:
            '{"type":"error","code":"proto::commands::run::missing_tool","message":"This project requires Bun 1.4.2, but this version has not been installed."}\n',
        },
        { "launchctl print": { stdout: LAUNCHD_PRINT } },
      );
      const result = schedule(box, "darwin", ["status"], { calls: [], run: failing.run });
      expect(result.code).toBe(1);
      const text = result.out.join("\n");
      expect(text).toContain("problem: the job's Bun");
      expect(text).toContain("does not start (exit 1: This project requires Bun 1.4.2");
      expect(text).toContain("it is pinned to 1.4.2");
      expect(text).toContain("bun: pinned to 1.4.2 (PROTO_BUN_VERSION)");
    });

    test("a runtime that no longer exists is not run, and the missing file is the one problem", () => {
      const box = sandbox();
      schedule(box, "darwin", ["install"], runner());
      rmSync(box.runtime);
      const asked = recording(
        { stdout: "1.4.2\n" },
        { "launchctl print": { stdout: LAUNCHD_PRINT } },
      );
      const result = schedule(box, "darwin", ["status", "--json"], { calls: [], run: asked.run });
      expect(asked.options).toEqual([]);
      const parsed = JSON.parse(result.out.join("\n"));
      expect(parsed.bunVersion).toBeNull();
      expect(parsed.problems).toHaveLength(1);
      expect(parsed.problems[0]).toContain("is missing");
    });

    test("not installed: nothing is run", () => {
      const box = sandbox();
      const asked = recording({ stdout: "1.4.2\n" });
      schedule(box, "darwin", ["status"], { calls: [], run: asked.run });
      expect(asked.options).toEqual([]);
    });

    test("end to end with a real child process: the shim sees the pin, the job's directory and no auto-install", () => {
      const box = sandbox({ explicitHome: true });
      const shims = join(box.home, ".proto", "shims");
      mkdirSync(shims, { recursive: true });
      const shim = join(shims, "bun");
      // Stands in for proto's shim: reports the environment and directory it was started in.
      writeFileSync(shim, '#!/bin/sh\necho "$PROTO_BUN_VERSION $PROTO_AUTO_INSTALL $(pwd -P)"\n');
      chmodSync(shim, 0o755);
      schedule(box, "darwin", ["install"], runner(), {
        resolveEntry: () => ({ runtime: shim, script: box.script, bunPin: pin }),
      });
      const printed = runner({ "launchctl print": { stdout: LAUNCHD_PRINT } });
      const result = schedule(
        box,
        "darwin",
        ["status", "--json"],
        { calls: [], run: printed.run },
        {
          run: (command, args, options) =>
            command === "launchctl"
              ? printed.run(command, args, options)
              : runCommand(command, args, options),
        },
      );
      expect(JSON.parse(result.out.join("\n")).bunVersion).toBe(
        `1.4.2 false ${realpathSync(box.tempadHome)}`,
      );
    });
  });
});
