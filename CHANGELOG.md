# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The GitHub collector's reconcile step compared `gh_commits.authored_at` to the window start as text. Rows stored before commit dates were normalized to UTC keep the author's offset (`2026-09-07T23:00:00-03:00`), so one near the window boundary could be skipped and its orphaned sha (after a history rewrite) never deleted. It now compares against a UTC-normalized bound, which is valid because every stored value is UTC: migration 0021 rewrites the legacy rows, and a pull rewrites any offset-form `gh_commits` dates that older pushes left on the sync server.

### Migration

- `0021_normalize_commit_dates.sql` rewrites legacy offset-form `gh_commits.authored_at` and `committed_at` to UTC (`2026-09-08T02:00:00.000Z`), the form the collector writes today. Rows already in UTC are untouched, a second run changes nothing, and push-sync state (`sync_updated_at`, `sync_host`, `sync_dirty`) is left as it was.

## [0.1.1] - 2026-10-16

### Added

- `/tempad:setup` skill: inside Claude Code it checks for bun, installs the CLI with `bun add -g @hyperlab.sh/tempad` when `tempad --version` fails, collects the configuration in conversation, runs `tempad setup --non-interactive` (secrets go in the environment, never echoed) and verifies with `tempad saga list`.
- `tempad --version` (and `-v`).

### Changed

- The skill `tempad-quest` is now `quest` (`packages/core/skills/quest`), invoked as `/tempad:quest` in the plugin. `tempad skill install` still writes it as `tempad-quest` under `~/.claude/skills` (a bare `quest` is too generic outside a plugin namespace) and rewrites the frontmatter name to match.
- The `UserPromptSubmit` hook line names `/tempad:quest` when the hook runs from the plugin and `the tempad-quest skill` for legacy `settings.json` hooks.
- `tempad init` is now `tempad setup`; `init` still works as a hidden alias that `--help` does not list. The source moved from `src/init` to `src/setup`.
- "Not set up" and "missing variable" errors now say: run `/tempad:setup` in Claude Code, or `tempad setup` in a terminal.
- README install order: add the marketplace, `claude plugin install tempad@hyperlab`, run `/tempad:setup`; the CLI route and other agents (`npx skills add hyperlab-sh/tempad --skill quest`) are optional subsections.

### Migration

A hand-copied `~/.claude/skills/tempad-quest` keeps working. Reinstall with `tempad skill install` to get the renamed source, or remove it and use the plugin.

## [0.1.0] - 2026-10-16

### Added

- Claude Code plugin `tempad` (`.claude-plugin/plugin.json`, `hooks/hooks.json`): installs the `tempad-quest` skill and the w5 hooks with `claude plugin install tempad@hyperlab`. The hooks run async where they can, are silent until tempad is configured, and stand down while legacy `settings.json` hooks exist.
- `tempad init`: interactive setup that writes `TEMPAD_HOME/.env` and `tempad.toml`, with `--non-interactive`, one flag per variable, `--home`, `--force` and `--no-verify`.
- npm package `@hyperlab.sh/tempad` (published from `packages/core`, runs on Bun 1.3.14 or newer): `bunx @hyperlab.sh/tempad` works from any directory. The name is scoped because npm rejected `tempad` as too similar to `temp`/`tempy`; the `tempad` bin and the Claude Code plugin name are unchanged.
- Repository scaffold: moon workspace, Biome, dprint, CI, community files.
- Design spec for the core collectors and SQLite schema (`docs/specs`).

### Changed

- Configuration is per command: each command validates only the variables it needs (`tempad sync monday` no longer requires `TZ`), and a missing one names the command and every missing variable.
- `tempad --help`, `-h` and `help` print every command and exit 0; an unknown command still exits 2.
- The w5 hook scripts exit silently, creating nothing, when tempad is not configured.
- A command that opens the database on an unconfigured home exits 1 with `tempad is not set up yet; run: bunx @hyperlab.sh/tempad init` instead of creating `~/.tempad/tempad.db`.
- A `.env` in the current directory is ignored; only the caller's environment and `TEMPAD_HOME/.env` count.
- The package is renamed from `@tempad/core` (private, never published) to `@hyperlab.sh/tempad`.
- The README is organised around the install path.

### Migration

Existing users with hooks in `~/.claude/settings.json`:

1. `claude plugin marketplace add hyperlab-sh/claude-plugins`, then `claude plugin install tempad@hyperlab`. The legacy hooks keep running and the plugin's hooks stand down while they exist.
2. `bunx @hyperlab.sh/tempad w5 hook uninstall`. The plugin's hooks take over on the next event.
3. Remove a hand-copied `~/.claude/skills/tempad-quest`; the plugin provides the skill.

Variables you already set in `~/.tempad/.env` keep working unchanged.
