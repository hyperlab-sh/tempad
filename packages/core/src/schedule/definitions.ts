/**
 * The files `tempad schedule install` writes, as pure text: a launchd LaunchAgent plist on macOS,
 * a systemd user service and timer on Linux. Nothing here touches the disk or runs a command, so
 * the content (paths with spaces, `%` and `$` in systemd, XML entities in the plist) is tested
 * on its own.
 */

/** launchd label, and the plist's file name without `.plist`. */
export const LAUNCHD_LABEL = "sh.hyperlab.tempad.sync";
/** systemd unit name without the `.service`/`.timer` suffix. */
export const SYSTEMD_UNIT = "tempad-sync";
export const SYNC_INTERVAL_SECONDS = 3600;
/** The timer's first run after it is activated (login, boot, `enable --now`): launchd's `RunAtLoad`. */
const SYSTEMD_FIRST_RUN = "1min";

/** What the scheduled job runs and where it logs. */
export interface ScheduleJob {
  /** The whole command line: runtime, its flags, the entry script, `sync`. Every element is absolute or a flag. */
  command: string[];
  /** The job's `PATH`: absolute entries only, the runtime's directory first. */
  path: string;
  /** Carried as `TEMPAD_HOME` only when it was set when the job was installed; null otherwise. */
  tempadHome: string | null;
  workingDirectory: string;
  /** stdout and stderr of every run, appended. */
  logPath: string;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function renderLaunchdPlist(job: ScheduleJob): string {
  const argumentLines = job.command.map(
    (argument) => `    <string>${escapeXml(argument)}</string>`,
  );
  const environment = [
    ["PATH", job.path],
    ...(job.tempadHome === null ? [] : [["TEMPAD_HOME", job.tempadHome]]),
  ].map(
    ([name, value]) =>
      `    <key>${escapeXml(name as string)}</key>\n    <string>${escapeXml(value as string)}</string>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentLines.join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment.join("\n")}
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(job.workingDirectory)}</string>
  <key>StartInterval</key>
  <integer>${SYNC_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(job.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(job.logPath)}</string>
</dict>
</plist>
`;
}

/** The `ProgramArguments` of a plist `renderLaunchdPlist` wrote; null when there are none. */
export function parseLaunchdCommand(plist: string): string[] | null {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  if (block === undefined) return null;
  const argumentsFound = [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
    unescapeXml(match[1] ?? ""),
  );
  return argumentsFound.length > 0 ? argumentsFound : null;
}

/** A path in a value systemd runs through specifier expansion: `%` is the escape character. */
function systemdSpecifiers(text: string): string {
  return text.replace(/%/g, "%%");
}

/** One word of an `ExecStart=` line: quoted when it holds anything the splitter would read, `$` and `%` doubled. */
function systemdWord(word: string): string {
  const escaped = systemdSpecifiers(word).replace(/\$/g, "$$$$");
  if (!/[\s"'\\;]/.test(escaped) && escaped !== "") return escaped;
  return `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `Environment=` takes one quoted `NAME=value` per assignment, so a value with spaces stays whole. */
function systemdAssignment(name: string, value: string): string {
  const escaped = systemdSpecifiers(`${name}=${value}`).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `Environment="${escaped}"`;
}

export function renderSystemdService(job: ScheduleJob): string {
  const environment = [
    systemdAssignment("PATH", job.path),
    ...(job.tempadHome === null ? [] : [systemdAssignment("TEMPAD_HOME", job.tempadHome)]),
  ];
  return `[Unit]
Description=tempad sync (collect Monday, GitHub and Claude Code history)

[Service]
Type=oneshot
WorkingDirectory=${systemdSpecifiers(job.workingDirectory)}
${environment.join("\n")}
ExecStart=${job.command.map(systemdWord).join(" ")}
StandardOutput=append:${systemdSpecifiers(job.logPath)}
StandardError=append:${systemdSpecifiers(job.logPath)}
`;
}

export function renderSystemdTimer(): string {
  return `[Unit]
Description=Run tempad sync every hour

[Timer]
OnActiveSec=${SYSTEMD_FIRST_RUN}
OnUnitActiveSec=1h
Persistent=true
Unit=${SYSTEMD_UNIT}.service

[Install]
WantedBy=timers.target
`;
}

/** Splits `ExecStart=`'s value the way `renderSystemdService` wrote it: double quotes, backslash escapes. */
function splitSystemdWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string;
    if (quoted) {
      if (character === "\\" && index + 1 < line.length) {
        index += 1;
        current += line[index];
      } else if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/** The `ExecStart=` words of a service `renderSystemdService` wrote; null when there is no such line. */
export function parseSystemdCommand(service: string): string[] | null {
  const line = /^ExecStart=(.*)$/m.exec(service)?.[1];
  if (line === undefined) return null;
  const words = splitSystemdWords(line).map((word) =>
    word.replace(/\$\$/g, "$").replace(/%%/g, "%"),
  );
  return words.length > 0 ? words : null;
}
