# Installable tempad: Claude Code plugin + npm package

Status: accepted (squad lead, 2026-10-16). Epic tempad-mqd.

Goal: installing tempad is one command and it just works.

```sh
claude plugin install tempad@hyperlab   # skill + hooks
bunx tempad init                        # writes TEMPAD_HOME/.env and tempad.toml
```

## Decided (operator)

- Distribution is a Claude Code plugin plus an npm package. The CLI runs on bun via `bunx`, bun shebang, no compiled binaries.
- Marketplace is `hyperlab-sh/claude-plugins` (marketplace `hyperlab`). This repo carries only `.claude-plugin/plugin.json` at its root, never a `marketplace.json`.
- The real `npm publish` is the operator's.

## 1. Per-command configuration

`loadConfig()` today requires all ten variables for every command. It becomes per-command.

- `env.ts` keeps one table of every variable (`ENV_VARS`): env name, `Config` key, description, `secret`, kind (`string | list | boolean`). `tempad init` and the error messages read this table; nothing else lists variable names.
- `tempadHome()` resolves `TEMPAD_HOME` (still `~/.tempad` when unset; that is a location, not a credential).
- `loadConfig(command, needs)` reads `process.env` then `TEMPAD_HOME/.env`, validates only the variables in `needs`, and returns `Pick<Config, K> & { home }`. A missing one throws `ConfigError` naming the command and every missing variable, e.g. `tempad sync monday needs MONDAY_API_TOKEN, MONDAY_USER; set them in ~/.tempad/.env or run: bunx tempad init`. No defaults for required values.
- Collectors and reports take the narrowest `Pick<Config, ...>` they read, so the type checker rejects a command that reads a field it did not ask for.
- Needs per command (from the 2026-10-16 call-site audit):

| Command                                                                                              | Needs                                                                               |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `sync monday`                                                                                        | MONDAY_API_TOKEN, MONDAY_USER                                                       |
| `sync github`                                                                                        | GH_USER, GH_ORGS, GH_INCLUDE_PERSONAL, GIT_AUTHOR_EMAILS, SINCE (GH_TOKEN optional) |
| `sync claude`                                                                                        | CLAUDE_DIRS, SINCE, HOST_SLUG                                                       |
| `sync` (all)                                                                                         | union of the three                                                                  |
| `report *`, `w5 eval`                                                                                | TZ                                                                                  |
| `w5 run`                                                                                             | CLAUDE_DIRS, HOST_SLUG (it re-syncs one session file)                               |
| intent commands, `impact`, `project`, `w5 enqueue/context/dedupe/review/backfill`, `quiet`, `review` | none                                                                                |
| `--help`, `init`, `skill install`, `w5 hook install/uninstall`                                       | none, and they open no database                                                     |

- `ANTHROPIC_API_KEY` stays as it is: required only when `[w5].backend = "api"`.
- **Configured** means `TEMPAD_HOME/.env` or `TEMPAD_HOME/tempad.db` exists (`isConfigured(home)`). A command that opens the database on an unconfigured home exits 1 with `tempad is not set up yet; run: bunx tempad init` instead of silently creating `~/.tempad/tempad.db`. The two hook-called commands, `w5 enqueue` and `w5 context`, exit 0 with no output and create nothing.
- `tempad --help` (and `-h`, `help`) prints every command, `w5`/`quiet`/`review` included, and exits 0. An unknown command still prints usage and exits 2.
- The CLI ignores a `.env` in the current directory. Bun loads `./.env` by default, and hooks run with the user's project as cwd, so a project's `TZ=UTC` would otherwise override `TEMPAD_HOME/.env`. Only `process.env` set by the caller and `TEMPAD_HOME/.env` count.

## 2. Plugin

- `.claude-plugin/plugin.json` at the repo root: `name: "tempad"`, version equal to the npm package version, `"skills": "./packages/core/skills/"`. Skills and hook scripts stay under `packages/core/` because the npm package ships the same files.
- `hooks/hooks.json` at the repo root (top-level `"hooks"` wrapper, as plugin hook files require) registers Stop, PreCompact, SessionEnd (stop script) and UserPromptSubmit (prompt script):
  `TEMPAD_HOOK_SOURCE=plugin bash "${CLAUDE_PLUGIN_ROOT}/packages/core/hooks/w5-stop.sh"`. No absolute paths.
- The hook scripts keep their paths: the live `settings.json` hooks on the operator's machines point at them.
- Each script, in order, exits 0 silently (stderr never reaches the session; diagnostics go to `TEMPAD_HOME/logs/w5.log` only once the home exists):
  1. no or malformed session id;
  2. tempad not configured (neither `TEMPAD_HOME/.env` nor `TEMPAD_HOME/tempad.db`);
  3. `TEMPAD_HOOK_SOURCE=plugin` and a legacy `settings.json` hook is still installed (user `~/.claude/settings.json` or `$CLAUDE_PROJECT_DIR/.claude/settings.json` contains `"tempad": true`). Legacy hooks keep working until `tempad w5 hook uninstall`, and the session never gets two enqueues or two context lines;
  4. no CLI resolvable. Resolution order: `TEMPAD_BIN` (legacy hooks set it), `tempad` on `PATH`, `bunx tempad` when `bun` is on `PATH`.
- `tempad w5 hook install` stays for checkout users and prints that the plugin is the recommended route. `tempad w5 hook uninstall` needs no configuration and is the migration step.

### Migration for existing users

1. `claude plugin install tempad@hyperlab`. Legacy hooks still run; plugin hooks stand down (rule 3).
2. `bunx tempad w5 hook uninstall` (or from the checkout). Plugin hooks take over on the next event.
3. Remove the old skill copy from `~/.claude/skills/tempad-quest` if it was hand-copied; the plugin provides it.

## 3. Skill

`tempad-quest` resolves the CLI before its first call: `tempad` on `PATH`, else `bunx tempad`, else it tells the user the one install command and stops. A CLI that answers "not set up" sends the user to `bunx tempad init`.

## 4. `tempad init`

- Prompts for every variable in `ENV_VARS` (secrets read without echo), with suggestions the user confirms: system time zone, hostname for `HOST_SLUG`, `git config user.email`, `~/.claude` for `CLAUDE_DIRS` (the config directory, offered when its `projects/` exists; `$CLAUDE_CONFIG_DIR` when set), `gh api user` for `GH_USER`. Suggestions are prompt text only; nothing becomes a runtime default.
- Flags for non-interactive use (`--non-interactive`, one flag per variable, `--home`, `--force`, `--no-verify`); a missing required value in non-interactive mode exits 1 naming it.
- Validates cheaply unless `--no-verify`: Monday token (GraphQL `me`), GitHub (`GH_TOKEN` against `/user`, else `gh auth status`), `CLAUDE_DIRS` exist, `TZ` is a valid IANA zone, `SINCE` parses.
- Writes `TEMPAD_HOME/.env` (mode 600) and a minimal commented `tempad.toml`. An existing file is kept unless `--force`; existing values are offered as the prompt suggestions (secrets shown as "keep current").
- Never prints a secret: the summary shows `set` for secret values.
- Prints next steps: install the plugin, `tempad hero init`, `tempad sync`, and `tempad w5 hook uninstall` when legacy hooks are found.

## 5. npm package

- Name `tempad` (unscoped; free on the registry 2026-10-16, as are `@hyperlab-sh/tempad` and `@tempad/core`). Unscoped gives the shortest one-command install, `bunx tempad`.
- `packages/core/package.json`: `name: "tempad"`, not private, `bin.tempad = ./src/cli.ts` (bun shebang already there), `engines.bun`, `files` whitelist (`src` without tests, `src/db/migrations`, `skills`, `hooks`, README, LICENSE), `repository`/`homepage`/`license`.
- Verified with `bun publish --dry-run` and a packed tarball run as `bunx tempad --help` from a clean directory.

## Out of scope

Compiled binaries, the real publish, push/sync (`feat/push-sync`), new migrations.
