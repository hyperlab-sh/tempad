import { describe, expect, test } from "bun:test";
import {
  parseLaunchdCommand,
  parseLaunchdEnvironment,
  parseSystemdCommand,
  parseSystemdEnvironment,
  renderLaunchdPlist,
  renderSystemdService,
  renderSystemdTimer,
  type ScheduleJob,
} from "../../src/schedule/definitions";

const job: ScheduleJob = {
  command: ["/opt/bun/bun", "--no-env-file", "/work/tempad/src/cli.ts", "sync"],
  path: "/opt/bun:/usr/bin:/bin",
  tempadHome: "/Users/me/.tempad",
  workingDirectory: "/Users/me/.tempad",
  logPath: "/Users/me/.tempad/logs/sync.log",
};

describe("launchd plist", () => {
  test("exact content: label, arguments, environment, hourly interval, run at load, one log", () => {
    expect(renderLaunchdPlist(job)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.hyperlab.tempad.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/bun/bun</string>
    <string>--no-env-file</string>
    <string>/work/tempad/src/cli.ts</string>
    <string>sync</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/bun:/usr/bin:/bin</string>
    <key>TEMPAD_HOME</key>
    <string>/Users/me/.tempad</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/me/.tempad</string>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/Users/me/.tempad/logs/sync.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/me/.tempad/logs/sync.log</string>
</dict>
</plist>
`);
  });

  test("TEMPAD_HOME is left out when it was not set", () => {
    const plist = renderLaunchdPlist({ ...job, tempadHome: null });
    expect(plist).not.toContain("TEMPAD_HOME");
    expect(plist).toContain("<key>PATH</key>");
  });

  test("paths with spaces stay one argument; XML metacharacters are escaped and read back", () => {
    const awkward: ScheduleJob = {
      ...job,
      command: ["/Users/me/My Tools/bun", "--no-env-file", "/Users/me/R&D <x>/cli.ts", "sync"],
      logPath: "/Users/me/My Home/.tempad/logs/sync.log",
    };
    const plist = renderLaunchdPlist(awkward);
    expect(plist).toContain("<string>/Users/me/My Tools/bun</string>");
    expect(plist).toContain("<string>/Users/me/R&amp;D &lt;x&gt;/cli.ts</string>");
    expect(plist).toContain("<string>/Users/me/My Home/.tempad/logs/sync.log</string>");
    expect(parseLaunchdCommand(plist)).toEqual(awkward.command);
  });

  test("parsing a plist with no arguments gives null", () => {
    expect(parseLaunchdCommand("<plist><dict></dict></plist>")).toBeNull();
  });
});

describe("systemd units", () => {
  test("exact service content", () => {
    expect(renderSystemdService(job)).toBe(`[Unit]
Description=tempad sync (collect Monday, GitHub and Claude Code history)

[Service]
Type=oneshot
WorkingDirectory=/Users/me/.tempad
Environment="PATH=/opt/bun:/usr/bin:/bin"
Environment="TEMPAD_HOME=/Users/me/.tempad"
ExecStart=/opt/bun/bun --no-env-file /work/tempad/src/cli.ts sync
StandardOutput=append:/Users/me/.tempad/logs/sync.log
StandardError=append:/Users/me/.tempad/logs/sync.log
`);
  });

  test("exact timer content: on the hour, catching up after downtime, no second trigger at activation", () => {
    expect(renderSystemdTimer()).toBe(`[Unit]
Description=Run tempad sync every hour

[Timer]
OnCalendar=hourly
Persistent=true
Unit=tempad-sync.service

[Install]
WantedBy=timers.target
`);
  });

  test("paths with spaces, quotes, % and $ are quoted and escaped, and read back", () => {
    const awkward: ScheduleJob = {
      ...job,
      command: ["/home/me/my tools/bun", "--no-env-file", '/srv/we"ird/100%/$HOME/cli.ts', "sync"],
      path: "/home/me/my tools:/usr/bin",
      tempadHome: "/home/me/t home",
      workingDirectory: "/home/me/t home",
      logPath: "/home/me/t home/logs/sync.log",
    };
    const service = renderSystemdService(awkward);
    expect(service).toContain(
      'ExecStart="/home/me/my tools/bun" --no-env-file "/srv/we\\"ird/100%%/$$HOME/cli.ts" sync',
    );
    expect(service).toContain('Environment="PATH=/home/me/my tools:/usr/bin"');
    expect(service).toContain('Environment="TEMPAD_HOME=/home/me/t home"');
    expect(service).toContain("WorkingDirectory=/home/me/t home\n");
    expect(service).toContain("StandardOutput=append:/home/me/t home/logs/sync.log\n");
    expect(parseSystemdCommand(service)).toEqual(awkward.command);
  });

  test("a % in the working directory and log path is doubled", () => {
    const service = renderSystemdService({
      ...job,
      workingDirectory: "/h/100%",
      logPath: "/h/100%/sync.log",
    });
    expect(service).toContain("WorkingDirectory=/h/100%%\n");
    expect(service).toContain("StandardError=append:/h/100%%/sync.log\n");
  });

  test("TEMPAD_HOME is left out when it was not set", () => {
    expect(renderSystemdService({ ...job, tempadHome: null })).not.toContain("TEMPAD_HOME");
  });

  test("a service with no ExecStart parses to null", () => {
    expect(parseSystemdCommand("[Service]\nType=oneshot\n")).toBeNull();
  });
});

describe("the job's environment", () => {
  const pinned: ScheduleJob = { ...job, protoBunVersion: "1.4.2" };

  test("PROTO_BUN_VERSION follows PATH and TEMPAD_HOME in both definitions, and only when set", () => {
    expect(renderLaunchdPlist(pinned)).toContain(
      "    <key>TEMPAD_HOME</key>\n    <string>/Users/me/.tempad</string>\n    <key>PROTO_BUN_VERSION</key>\n    <string>1.4.2</string>\n  </dict>",
    );
    expect(renderSystemdService(pinned)).toContain(
      'Environment="TEMPAD_HOME=/Users/me/.tempad"\nEnvironment="PROTO_BUN_VERSION=1.4.2"\nExecStart=',
    );
    for (const unpinned of [job, { ...job, protoBunVersion: null }]) {
      expect(renderLaunchdPlist(unpinned)).not.toContain("PROTO_BUN_VERSION");
      expect(renderSystemdService(unpinned)).not.toContain("PROTO_BUN_VERSION");
    }
  });

  test("the environment reads back from both definitions", () => {
    const expected = {
      PATH: "/opt/bun:/usr/bin:/bin",
      TEMPAD_HOME: "/Users/me/.tempad",
      PROTO_BUN_VERSION: "1.4.2",
    };
    expect(parseLaunchdEnvironment(renderLaunchdPlist(pinned))).toEqual(expected);
    expect(parseSystemdEnvironment(renderSystemdService(pinned))).toEqual(expected);
  });

  test("awkward values survive the round trip: spaces, quotes, XML metacharacters and %", () => {
    const awkward: ScheduleJob = {
      ...pinned,
      path: "/Users/me/My Tools:/usr/bin",
      tempadHome: '/Users/me/R&D <x> "100%"',
    };
    const expected = {
      PATH: awkward.path,
      TEMPAD_HOME: awkward.tempadHome as string,
      PROTO_BUN_VERSION: "1.4.2",
    };
    expect(parseLaunchdEnvironment(renderLaunchdPlist(awkward))).toEqual(expected);
    expect(parseSystemdEnvironment(renderSystemdService(awkward))).toEqual(expected);
  });

  test("a definition with no environment reads back empty", () => {
    expect(parseLaunchdEnvironment("<plist><dict></dict></plist>")).toEqual({});
    expect(parseSystemdEnvironment("[Service]\nExecStart=/bin/true\n")).toEqual({});
  });
});
