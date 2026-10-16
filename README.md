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

The first release stores traces, places and projects. Sagas, quests and stints arrive with the `w5` hook (see the roadmap).

## Features

- **Collectors** for Monday.com items assigned to you, GitHub commits and pull requests across one or more orgs (plus optional personal repos), and Claude Code session transcripts from any number of `~/.claude*` directories.
- **Incremental sync.** Each source records where it left off. Git repos are kept as bare mirrors so rewritten history is re-diffed, not trusted.
- **Path rules** map working directories to `org` and `project` using WHATWG `URLPattern` syntax, so `~/work/:org/:project/:rest*` is a complete config.
- **Reports** per day, per project, and hour by hour, generated deterministically from the database as Markdown.
- **w5 table** (planned): a Claude Code hook that periodically asks a small model _who, when, what, why, where_ about the live session and stores the answer.

## Installation

Requires [Bun](https://bun.sh) 1.3+.

```sh
bun install
```

## Quick Start

```sh
mkdir -p ~/.tempad
cp packages/core/.env.example ~/.tempad/.env   # fill in tokens and ids
cp packages/core/tempad.example.toml ~/.tempad/tempad.toml

bun run tempad sync            # all sources
bun run tempad sync claude     # one source
bun run tempad report daily --from 2026-08-18 --to 2026-08-28

bun run tempad w5 hook install # wire up the w5 self-awareness hook
bun run tempad w5 backfill     # classify recent sessions the hook missed
```

Reports land in `~/.tempad/reports/`.

The w5 hook classifies through the local `claude` CLI (`[w5].backend = "claude-cli"`, the default) using whatever subscription you're logged into — no `ANTHROPIC_API_KEY` needed. Set `[w5].backend = "api"` in `tempad.toml` to call the Anthropic API directly instead (requires `ANTHROPIC_API_KEY`).

## Repository layout

| Path            | Why                                                                 |
| --------------- | ------------------------------------------------------------------- |
| `packages/core` | TypeScript library and `tempad` binary: schema, collectors, reports |
| `apps/`         | Runnable programs (a Go TUI built on charmbracelet is planned)      |
| `libs/`         | Private, bundle-time only packages shared across apps               |
| `docs/specs`    | Design specs                                                        |

Tooling: [moon](https://moonrepo.dev) orchestrates tasks, [Biome](https://biomejs.dev) lints and formats JS/TS/JSON, [dprint](https://dprint.dev) formats Markdown, TOML and YAML.

## Roadmap

- **Profiles.** All configuration is global today (`TEMPAD_HOME/.env` and `tempad.toml`), so one machine can only serve one TemPad. Introduce profiles (for example `~/.tempad/profiles/<name>/` selected by `--profile` or `TEMPAD_PROFILE`) so a person can keep separate databases, tokens and path rules per client or per persona.
- **w5 hook.** A Claude Code hook that periodically asks a small model _who, when, what, why, where, how_ about the live session and writes a trace, opening or matching stints, quests and side quests (with their nexus events), with a batch backfill over existing sessions. This is what turns raw sessions into "things I worked on", including side quests that never produced a commit.
- **Weekly table.** Per weekday, per project: stints and quests touched, shipped vs abandoned, side-quest share. Depends on the w5 hook.
- **Places in config.** Replace the separate `[[projects]]`, `[[repositories]]` and `[[boards]]` rules with one `[[places]]` list with a `kind`.
- **Sagas and drift.** Set sagas and get a nudge when time drifts away from them for too long.
- **TUI** in Go (charmbracelet) under `apps/`.
- **Timesheet export.** A recurring agent that fills external timesheets (Deel) from the reports.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
