# TemPad

> Reconstruct what you, and your agents, worked on, hour by hour, from git, Monday.com and Claude Code sessions.

[![CI](https://github.com/hyperlab-sh/tempad/actions/workflows/ci.yml/badge.svg)](https://github.com/hyperlab-sh/tempad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)

<p align="center">
  <!-- Mascot: Miss Minutes belongs to Marvel/Disney and is not redistributed here. -->
  <a href="https://marvelcinematicuniverse.fandom.com/wiki/Miss_Minutes">
    <img
      src="docs/assets/mascot-placeholder.svg"
      alt="TemPad mascot placeholder, an orange retro clock"
      width="160"
    />
  </a>
</p>

Named after the TVA's handheld from _Loki_: the device that opens time doors and watches the Sacred Timeline for branches. This one only looks backwards. It pulls every trace of work you leave behind, stores it in SQLite, and lets you rebuild a timesheet you would otherwise have to remember.

## Why

Commits get batched and pushed days after the work. Planning leaves no git trace. Agents run in the background across several checkouts. By Friday nobody remembers what Tuesday was. TemPad collects the evidence so the report writes itself.

## Domain language

TemPad is a self-awareness tool, not a surveillance tool. It exists to show what you did, why, and where your attention went, so you can change it. These are the words it uses.

- **Saga**: a direction, open-ended, owned by the hero or a party. A quest _serves_ a saga.
- **Quest**: planned work with an outcome. A quest may _advance_ another quest (contributing work) or _deviate from_ one; a quest that deviates is a side quest and carries the nexus event. Never both.
- **Stint**: a stretch of the user's attention pursuing one quest. It starts when you begin pursuing an outcome and ends when that outcome is delivered, abandoned or handed off, or after an idle gap. Stints interleave. It lasts at least `stint_min_minutes` (default 5); shorter stretches are maneuvers, and their time is counted under the quest without a stint.

  Three tests: **the report test** (would it be its own line in a standup or timesheet?), **the same-answer test** (while it lasts, the answer to "what am I trying to finish" does not change), **the handoff test** (when the outcome leaves your hands, it is over; waiting is not a stint, checking on someone is a maneuver of the stint that handed off).
- **Maneuver**: anything done inside a stint: read a file, run tests, rebase, check on a dev, answer a clarifying question. Never reported on its own.
- **Trace**: evidence of a stint, from a tool at a place at a time.
- **Declaration**: the executor stating which quest the coming work pursues.
- **Nexus Event**: the moment attention branched: when, from what, and what pulled you.
- **Project**: an undertaking with a name, people, and places.
- **Place**: one spot where work leaves a trace: a repo, a board, a folder, a channel. A place belongs to one project and is reached through one tool.
- **Tool**: what you work through: Claude Code, git, Monday, a browser.
- **Hero**: you. The root everything hangs from.
- **Party**: a group the hero belongs to, with a membership span. Sagas and quests can belong to the hero or to a party.
- **Client**: who a project is for. Not a party.

Rule of thumb: Sagas give direction, Quests are planned, Stints are what happened, Maneuvers are how, Traces are the proof, Places are where, Tools are how, Projects are whose and what for.

Sagas, quests and stints come from the `w5` hook and the `quest` skill (see [Declaring quests](#declaring-quests)).

## Features

- **Collectors** for Monday.com items assigned to you, GitHub commits and pull requests across one or more orgs (plus optional personal repos), and Claude Code session transcripts from any number of `~/.claude*` directories.
- **Incremental sync.** Each source records where it left off. Git repos are kept as bare mirrors so rewritten history is re-diffed, not trusted.
- **Path rules** map working directories to `org` and `project` using WHATWG `URLPattern` syntax, so `~/work/:org/:project/:rest*` is a complete config.
- **Reports** per day, per project, per week and hour by hour, generated deterministically from the database as Markdown.
- **w5 hook.** A Claude Code hook that periodically classifies the live session into stints and traces under the quests you declared, handing doubts back to you instead of guessing. It classifies through your local `claude` CLI, so no API key is needed.
- **Per-command configuration.** A command checks only the variables it needs, so `tempad report` never asks for a Monday token.

## Install

Requires [Bun](https://bun.sh) 1.3.14 or newer and [Claude Code](https://claude.com/claude-code). The [GitHub CLI](https://cli.github.com) (`gh`) is optional: without a `GH_TOKEN`, GitHub sync uses its credentials.

1. **Add the marketplace:**

   ```sh
   claude plugin marketplace add hyperlab-sh/claude-plugins
   ```

2. **Install the plugin** (the `quest` and `setup` skills and the w5 hooks):

   ```sh
   claude plugin install tempad@hyperlab
   ```

3. **Run `/tempad:setup` in Claude Code.** It checks for bun, installs the `tempad` CLI globally, asks for your settings, writes `~/.tempad/.env` and `tempad.toml`, and verifies the result. Secrets are passed through the environment and never echoed.

Then sync and report:

```sh
tempad hero init "Your Name"
tempad sync
tempad report daily --from 2026-08-18 --to 2026-08-28
```

Reports are printed and written to `~/.tempad/reports/`.

### Optional: use the CLI directly

The CLI is published to npm as [`@hyperlab.sh/tempad`](https://www.npmjs.com/package/@hyperlab.sh/tempad). Without Claude Code:

```sh
bun add -g @hyperlab.sh/tempad
tempad setup
```

`bunx @hyperlab.sh/tempad <command>` runs it once without installing. The plugin's hooks and skills use `tempad` when it is on your `PATH`, else `bunx`.

### Other agents (Codex, Cursor, etc.)

The `quest` skill is plain `SKILL.md`; install it with the [skills](https://github.com/vercel-labs/skills) CLI:

```sh
npx skills add hyperlab-sh/tempad --skill quest
```

### What the plugin installs

- The **`quest` skill** (`/tempad:quest`), which has the session declare which quest it is pursuing (`tempad quest declare`) so work is tracked under the right outcome instead of guessed.
- **Hooks** on `Stop`, `PreCompact`, `SessionEnd` and `UserPromptSubmit` that enqueue classification jobs and hand open doubts back to the session. They never block a session and are **silent until tempad is configured**: with no `~/.tempad/.env` or `tempad.db` they exit 0 with no output and create nothing.

The hooks find the CLI as `TEMPAD_BIN`, then `tempad` on `PATH`, then `bunx @hyperlab.sh/tempad`.

### `tempad setup`

`tempad setup` (the old name `tempad init` still works) prompts for every variable below (secrets are read without echo), suggesting a value where it can: the system time zone, the hostname, `git config user.email`, `~/.claude` for `CLAUDE_DIRS` (the Claude config directory, not its `projects/` subfolder; `$CLAUDE_CONFIG_DIR` when that is set and has `projects/`), `gh api user`. It then validates what it can cheaply, writes `TEMPAD_HOME/.env` (mode 600) and a minimal commented `tempad.toml`, and prints the next steps. An existing `.env` is only updated after you confirm (non-interactive runs refuse unless `--force`), its values become the prompt suggestions, and an existing `tempad.toml` is kept. With `--force` both files are replaced without asking, and the old ones are left beside them as `.env.bak` and `tempad.toml.bak`. It never prints a secret.

| Flag                           | Effect                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--non-interactive`            | No prompts; a missing required value exits 1 naming it                                                                                                    |
| `--<variable>` (see the table) | Sets one variable, e.g. `--monday-api-token`, `--gh-orgs`, `--tz`; the flag is the name in kebab case                                                     |
| `--home <path>`                | Use this directory as `TEMPAD_HOME` for this run                                                                                                          |
| `--force`                      | Overwrite an existing `.env` and `tempad.toml`, keeping `.env.bak` and `tempad.toml.bak`                                                                  |
| `--no-verify`                  | Skip the network and filesystem checks (Monday token, GitHub credentials, `CLAUDE_DIRS` exist); format checks (booleans, lists, `TZ`, `SINCE`) always run |

```sh
tempad setup --non-interactive --monday-api-token "$TOKEN" --monday-user 12345 \
  --gh-user octocat --gh-orgs my-org --gh-include-personal false \
  --git-author-emails me@example.com --claude-dirs ~/.claude --host-slug laptop \
  --tz Europe/Berlin --since 2026-01-01
```

### Migrating from settings.json hooks

If you installed the hooks with `tempad w5 hook install` (they live in `~/.claude/settings.json`, or in `$CLAUDE_CONFIG_DIR/settings.json` if you set that variable, marked `"tempad": true`), switch to the plugin without a gap:

1. `claude plugin install tempad@hyperlab`. The legacy hooks keep running and the plugin's hooks stand down while they exist, so a session never gets two enqueues or two context lines.
2. `bunx @hyperlab.sh/tempad w5 hook uninstall` (or run it from your checkout). It needs no configuration, uses the same settings file the hooks were installed into (`$CLAUDE_CONFIG_DIR` when set, else `~/.claude`), prints which file it changed, and removes only the entries it marked. The plugin's hooks take over on the next event.
3. Remove the old skill copy if you copied it by hand: `rm -r ~/.claude/skills/tempad-quest` (under `$CLAUDE_CONFIG_DIR/skills/` if you set that variable). The plugin provides it.

`tempad w5 hook install` still exists for checkout users; it prints that the plugin is the recommended route.

## Configuration

`TEMPAD_HOME` (default `~/.tempad`; a leading `~` is expanded, also by the hook scripts) holds everything tempad writes: `.env`, `tempad.toml`, `tempad.db`, `repos/` (bare git mirrors), `reports/` and `logs/`. Nothing lives in your project.

Settings are read from the real environment first, then `TEMPAD_HOME/.env`. A `.env` in the current directory is ignored on purpose: hooks run with your project as the working directory, and a project's `TZ` must not override yours.

Each command checks only the variables it needs and fails naming the command and every missing variable, for example `tempad sync monday needs MONDAY_API_TOKEN, MONDAY_USER; set them in ~/.tempad/.env or run /tempad:setup in Claude Code, or `tempad setup` in a terminal`. Required variables have no defaults.

| Variable              | Meaning                                                                   | Needed by                    |
| --------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| `MONDAY_API_TOKEN`    | Monday.com personal API token (secret)                                    | `sync monday`                |
| `MONDAY_USER`         | Your Monday.com user: numeric id or display name                          | `sync monday`                |
| `GH_USER`             | Your GitHub login                                                         | `sync github`                |
| `GH_ORGS`             | Comma-separated GitHub organizations to mirror                            | `sync github`                |
| `GH_INCLUDE_PERSONAL` | Also mirror your personal repositories (`true` or `false`)                | `sync github`                |
| `GH_TOKEN`            | GitHub token (secret). Optional: `gh auth` credentials are used if unset  | `sync github`                |
| `GIT_AUTHOR_EMAILS`   | Comma-separated commit author emails that count as yours                  | `sync github`                |
| `CLAUDE_DIRS`         | Comma-separated Claude Code config directories holding `projects/*.jsonl` | `sync claude`, `w5 run`      |
| `HOST_SLUG`           | Short name for this machine, stored with every Claude session             | `sync claude`, `w5 run`      |
| `TZ`                  | IANA time zone that places work on days, e.g. `Europe/Berlin`             | `report *`, `w5 eval`        |
| `SINCE`               | Earliest date to sync, `YYYY-MM-DD`                                       | `sync github`, `sync claude` |

`sync` with no source needs the union of the three. The intent commands (`hero`, `party`, `client`, `saga`, `quest`, `stint`, `trace`, `answer`, `rebuild`, `impact`, `project`), `quiet`, `review` and most `w5` subcommands need no variables. `--help`, `--version`, `setup` (and its hidden alias `init`), `skill install` and `w5 hook install|uninstall` need no configuration at all and never open the database. Any command that opens the database on an unconfigured home exits 1 with `tempad is not set up yet; run /tempad:setup in Claude Code, or `tempad setup` in a terminal`.

`ANTHROPIC_API_KEY` is only required when `[w5].backend = "api"`; like the other settings it is read from the real environment, then from `TEMPAD_HOME/.env`, and `tempad setup --force` keeps that line when it rewrites the file.

### `tempad.toml`

`tempad.toml` holds what is not a credential: path rules, the intent layer and the w5 settings. A minimal one:

```toml
[hero]
name = "Your Name"

# First match wins; list exact-folder `path` rules before `pattern` rules.
[[projects]]
path = "~/work/acme/website"
name = "Acme Website"
org = "acme"
project = "website"

[[projects]]
pattern = "~/work/:org/:project/:rest*"

# Optional: map a GitHub repository or a Monday board to org/project.
# [[repositories]]
# full_name = "Acme/my-repo"
# org = "acme"
# project = "my-repo"
#
# [[boards]]
# name = "My Board"
# org = "acme"
# project = "my-project"

[w5]
backend = "claude-cli" # or "api" (needs ANTHROPIC_API_KEY)
mode = "declared"
```

Notable `[w5]` defaults: `backend = "claude-cli"`, `mode = "declared"`, `timeout_seconds = 180`, `stint_min_minutes = 5`. `tempad project register <path> --name "<display>"` adds a path rule for you.

## Usage

```sh
tempad sync [monday|github|claude] [--full]
tempad report <daily|project|hourly|weekly> --from <date> --to <date> [--org X] [--project Y] [--out path]
tempad w5 backfill      # classify recent sessions the hook missed
tempad review           # open doubts and unconfirmed quests
tempad --help           # every command
```

`--full` clears a source's last-sync cursor so it rescans back to `SINCE`.

### Declaring quests

The w5 hook classifies through the local `claude` CLI (`[w5].backend = "claude-cli"`, the default) using whatever subscription you are logged into. Set `[w5].backend = "api"` in `tempad.toml` to call the Anthropic API directly instead (requires `ANTHROPIC_API_KEY`).

In `declared` mode the session states its quest (the `quest` skill does this) and the classifier only verifies that each stretch of work serves it, asking you when it doubts. The design is in [`docs/specs`](docs/specs).

## Sync across machines (optional)

Each machine keeps its own `tempad.db`. To see the same history on several machines, point them all at one self-hosted [sqld](https://github.com/tursodatabase/libsql) server:

```toml
# TEMPAD_HOME/tempad.toml
[sync]
url = "libsql://tempad-sync.example.com"
```

```sh
# TEMPAD_HOME/.env
TEMPAD_SYNC_TOKEN=<a JWT signed with the server's key>
```

With `[sync]` present, `tempad sync` pushes this machine's changes and pulls the others' after collecting. `tempad sync --push` or `tempad sync --pull` runs one direction only, without collecting. Without `[sync]`, tempad never opens a network connection for sync. To leave sync for good, remove `[sync]` from `tempad.toml` and run `tempad sync --forget`: it drops the sync bookkeeping (triggers, tombstones, cursors, server identity) so the database stops tracking changes for a server you no longer use. It never touches the network or your data, and it refuses while changes have not reached the server (`--force` overrides). The database then refuses to sync with the server it left, because rejoining would overwrite newer edits from other hosts; use a fresh server, or an empty `tempad.db` and a pull.

If the server is lost or replaced, the next `tempad sync` from any one host re-seeds it with everything that host holds, including rows other hosts wrote. After restoring the server from a backup, run `DELETE FROM sync_meta WHERE key = 'server_id'` on it, so every host re-seeds (see `docs/deploy/sqld-coolify.md`).

`[sync].url` takes no query string, fragment or `user:pass@`; the token comes only from `TEMPAD_SYNC_TOKEN`.

Every host must run identical `[[projects]]` rules in `tempad.toml`. Collectors compute org, project and display name from the local rules and sync them as data, so hosts with different rules overwrite each other's values on every sync.

Two hosts started from a copy of the same pre-sync `tempad.db` tag the shared old events with different hosts. That is harmless: events are deduplicated by their global id.

Server setup (Coolify, JWT keys, backups): `docs/deploy/sqld-coolify.md`. Protocol and conflict rule: `docs/specs/push-sync.md`.

## Repository layout

| Path             | Why                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`  | The npm package `tempad`: TypeScript library and `tempad` binary (schema, collectors, reports), the skill and the hook scripts |
| `.claude-plugin` | The Claude Code plugin manifest (version matches `packages/core/package.json`)                                                 |
| `hooks`          | The plugin's hook registration (`hooks.json`)                                                                                  |
| `apps/`          | Runnable programs (a Go TUI built on charmbracelet is planned)                                                                 |
| `libs/`          | Private, bundle-time only packages shared across apps                                                                          |
| `docs/specs`     | Design specs                                                                                                                   |

## Development

```sh
git clone git@github.com:hyperlab-sh/tempad.git
cd tempad
bun install
bun packages/core/src/cli.ts --help   # run the CLI from the checkout
```

The gates, all of which CI runs:

```sh
bun run lint        # biome check
bun run typecheck
bun test
bun run fmt:check   # biome + dprint; `bun run fmt` fixes
```

Tooling: [moon](https://moonrepo.dev) orchestrates tasks, [Biome](https://biomejs.dev) lints and formats JS/TS/JSON, [dprint](https://dprint.dev) formats Markdown, TOML and YAML. Bun is pinned to 1.3.14 in `.prototools`.

To try the packed package the way users get it: `cd packages/core && bun pm pack`, then `bun add <tarball>` in an empty directory.

## Roadmap

- **Profiles.** All configuration is global today (`TEMPAD_HOME/.env` and `tempad.toml`), so one machine can only serve one TemPad. Introduce profiles (for example `~/.tempad/profiles/<name>/` selected by `--profile` or `TEMPAD_PROFILE`) so a person can keep separate databases, tokens and path rules per client or per persona.
- **Places in config.** Replace the separate `[[projects]]`, `[[repositories]]` and `[[boards]]` rules with one `[[places]]` list with a `kind`.
- **Sagas and drift.** Set sagas and get a nudge when time drifts away from them for too long.
- **TUI** in Go (charmbracelet) under `apps/`.
- **Timesheet export.** A recurring agent that fills external timesheets (Deel) from the reports.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
