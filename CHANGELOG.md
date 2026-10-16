# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Claude Code plugin `tempad` (`.claude-plugin/plugin.json`, `hooks/hooks.json`): installs the `tempad-quest` skill and the w5 hooks with `claude plugin install tempad@hyperlab`. The hooks run async where they can, are silent until tempad is configured, and stand down while legacy `settings.json` hooks exist.
- `tempad init`: interactive setup that writes `TEMPAD_HOME/.env` and `tempad.toml`, with `--non-interactive`, one flag per variable, `--home`, `--force` and `--no-verify`.
- npm package `tempad` (published from `packages/core`, runs on Bun 1.3.14 or newer): `bunx tempad` works from any directory.
- Repository scaffold: moon workspace, Biome, dprint, CI, community files.
- Design spec for the core collectors and SQLite schema (`docs/specs`).

### Changed

- The npm package is published as `@hyperlab.sh/tempad` (npm rejected `tempad` as too similar to `temp`/`tempy`); run it with `bunx @hyperlab.sh/tempad`. The `tempad` bin and the Claude Code plugin name are unchanged.
- Configuration is per command: each command validates only the variables it needs (`tempad sync monday` no longer requires `TZ`), and a missing one names the command and every missing variable.
- `tempad --help`, `-h` and `help` print every command and exit 0; an unknown command still exits 2.
- The w5 hook scripts exit silently, creating nothing, when tempad is not configured.
- A command that opens the database on an unconfigured home exits 1 with `tempad is not set up yet; run: bunx tempad init` instead of creating `~/.tempad/tempad.db`.
- A `.env` in the current directory is ignored; only the caller's environment and `TEMPAD_HOME/.env` count.
- The package is renamed from `@tempad/core` (private, never published) to `tempad`.
- The README is organised around the install path.

### Migration

Existing users with hooks in `~/.claude/settings.json`:

1. `claude plugin marketplace add hyperlab-sh/claude-plugins`, then `claude plugin install tempad@hyperlab`. The legacy hooks keep running and the plugin's hooks stand down while they exist.
2. `bunx tempad w5 hook uninstall`. The plugin's hooks take over on the next event.
3. Remove a hand-copied `~/.claude/skills/tempad-quest`; the plugin provides the skill.

Variables you already set in `~/.tempad/.env` keep working unchanged.
