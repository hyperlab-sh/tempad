import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_VARS } from "../src/config/env.ts";

/**
 * Every variable the code under test reads from the environment and that names something of
 * the developer's: where their files live, or a credential. `src/` reads the `ENV_VARS` table
 * (secrets included), `ANTHROPIC_API_KEY`, `TEMPAD_HOME`, `TEMPAD_HOOK_SOURCE`, `HOME`, and
 * `CLAUDE_CONFIG_DIR` (settings.json and the skills directory), `XDG_CONFIG_HOME` (the systemd user units `tempad schedule` writes), `PROTO_HOME` (the Bun shim it looks for); the hook scripts add
 * `CLAUDE_PROJECT_DIR`, `TEMPAD_BIN` and `HOME`. A new `process.env` read in `src/` that names a
 * user-scoped location must be listed here; `test/isolation.test.ts` pins the list against `ENV_VARS`.
 */
export const USER_SCOPED_VARIABLES: readonly string[] = [
  ...ENV_VARS.map((variable) => variable.name),
  "ANTHROPIC_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "TEMPAD_BIN",
  "XDG_CONFIG_HOME",
  "PROTO_HOME",
  "TEMPAD_HOME",
  "TEMPAD_HOOK_SOURCE",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

/**
 * Pinned rather than removed. git reads `~/.gitconfig` and the system file, so a developer's
 * `commit.gpgsign` or ssh signing key reached every fixture commit (and, with the HOME swap
 * alone, made them fail looking for `~/.ssh/id_rsa`). `/dev/null` is an empty config (git 2.32+).
 */
export const PINNED_VARIABLES: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/**
 * Points this process at a throwaway HOME and removes every user-scoped variable, so a test
 * that installs a skill or hook, or opens `TEMPAD_HOME`, can only ever write under a temporary
 * directory, whatever the developer exported. `TEMPAD_HOME` is set to `<home>/.tempad`, not
 * removed: `tempadHome()` falls back to `os.homedir()`, which Bun freezes at startup to the real
 * home. A test that needs it unset deletes it itself.
 *
 * A subprocess only sees this when the test passes `env` explicitly (`env: process.env`, or a
 * spread of it): `Bun.spawn`, `Bun.spawnSync` and `child_process` called without `env` hand the
 * child the environment the run was started with. The one exception is `sync/sqld.integration`'s
 * `docker` and `ssh` calls, which must keep the developer's HOME to find the docker context and
 * ssh keys; they write nothing. Returns a function that restores the environment and deletes the directory.
 * `test/preload.ts` calls this once per `bun test` run, before any test file loads.
 */
export function isolateProcessEnvironment(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const name of ["HOME", ...USER_SCOPED_VARIABLES, ...Object.keys(PINNED_VARIABLES)]) {
    saved.set(name, process.env[name]);
  }
  const home = mkdtempSync(join(tmpdir(), "tempad-test-home-"));
  for (const name of USER_SCOPED_VARIABLES) delete process.env[name];
  Object.assign(process.env, PINNED_VARIABLES);
  process.env.HOME = home;
  process.env.TEMPAD_HOME = join(home, ".tempad");
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  };
}

/**
 * Runs `run` with `overrides` applied to `process.env` (a `null` value deletes the variable) and
 * restores every touched variable afterwards, even when `run` throws. For a test that needs a
 * specific HOME or CLAUDE_CONFIG_DIR and must not depend on what the run was started with.
 */
export function withEnvironment<T>(overrides: Record<string, string | null>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const name of Object.keys(overrides)) saved.set(name, process.env[name]);
  try {
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
