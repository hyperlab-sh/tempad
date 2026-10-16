# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `tempad sync --forget` is the off switch for a host that leaves sync for good. After you remove `[sync]` from `tempad.toml`, it drops the 18 sync triggers, every tombstone, the pull cursors and the server identity in one transaction, and the database stops tracking changes for a server you no longer use. It refuses with exit 1 while `[sync]` is still enabled, and while deletes or changes have not reached the server (`N deletes / M changes never reached the server`) unless you pass `--force`. It prints `sync: forgot triggers=<n> tombstones=<n> cursors=<n> meta=<n>` (or `sync: nothing to forget`), needs no token, never touches the network, and leaves your data and the `sync_*` columns alone. The database remembers the id of every server it left (a growing set) and refuses to sync with any of them again (`ForgottenServerError`): rejoining would restamp every row as new and overwrite edits other hosts made since, and bring back rows they deleted. Point `[sync]` at a fresh server instead, start from an empty `tempad.db` and pull, or run `tempad sync --rejoin <server-id>` to accept the overwrites for one server. A second `--forget` is not blocked by rows written after the first.
- `tempad quest retract <id> --reason "..." [--force]` (alias `quest delete`) undoes a quest created by mistake. `abandon` is for work that was dropped and keeps the quest in reports; retract appends a `retracted` event so the quest disappears everywhere. The reason is required. It refuses (exit 1) when the quest has live stints or traces, child quests (serving, advancing, deviating from or merged into it) or was itself merged into another, unless `--force`, which retracts those dependents too (traces, stints, child quests); the quest it was merged into is untouched. Retracting an already retracted quest prints a message and exits 0. The quest skill now says to retract a mistaken quest instead of abandoning it.

### Fixed

- A side quest declared with `tempad quest declare --new <title> --deviates-from <quest>` is now recorded on the new quest, naming the quest it left. It used to be stored the other way round, on the quest being left, with the new quest's id in its stint column, so `quest list --side`, the classifier's recent side quests and the daily report's "Side quests" section showed the wrong quest (and overwrote that quest's own side-quest relation, if it had one). Old events are not rewritten: the projection recognizes the old shape and reads it the right way round, and migration 0024 adds the `quests.deviates_from_quest_id` column and re-projects the `quests` table from the event log while it migrates, so existing rows are repaired on the first run of the new version with nothing to do by hand. A host still on an older version keeps writing the old shape until it upgrades; the result is the same once it does. `tempad quest branch <side> --deviates-from` now takes a quest id as well as a stint id, and `--at <iso>` to place the branch in the past, so a quest can be made a side quest of another after the fact. `quest list` marks each side quest with `side quest of <parent>`, and `tempad answer --origin current` records the quest being left instead of a `null` stint when the session has no earlier stint of it. `quest retract` no longer needs its workaround for the inverted shape.
- `openDatabase` no longer leaks the SQLite handle when a migration throws: it closes the connection and rethrows, as it already did for a failing trigger check or host-slug write.
- `tempad sync --rejoin ''` and `--rejoin <unknown id>` now exit 1 with a message on stderr instead of exiting 0 as if something had happened. `tempad sync --rejoin` with no value and any unknown sync flag (`--bogus`) now print one `sync: <reason>` line plus the usage and exit 2, instead of a raw `parseArgs` stack trace.
- The prompt hook no longer tells a session that has declared a quest that it has none. A `declare` question queued before the declaration was still asked afterwards and printed `w5 has no declared quest for this session` right under `active quests: <title> [Q1]`. The w5 run now resolves such a question once the session has an active quest (a quest ended with `--done` or retracted does not count, so the question stands then), and `w5 context` and `tempad review` skip it on the same rule.
- Commit dates with a UTC offset of +-15:00 or more (never emitted by git, only by imported history) were left in offset form by migration 0021, because SQLite's `strftime` returns NULL for them, while a host that pulled the same row stored UTC. Migration 0023 now rewrites them to the same UTC text, once, atomically with the version bump, without restamping or re-dirtying the row, so every host holds one text per instant and later opens pay nothing.
- `tempad sync` reports a failed push or pull the same way every time: the exit code is 1 and stderr gets one `sync: push failed: <reason>` line (`sync: pull failed: <reason>` for `--pull` alone). It covers a missing `@libsql/client` package, an unreachable server, a rejected token and any server error. The collectors' results are kept, and the token is scrubbed from the reason.
- Retracted quests no longer show up. `quest list` hides them (`--all` shows them marked `(retracted)`, and `--side`/`--unconfirmed` hide them), the classifier is no longer offered them in inferred mode, reports no longer name a retracted quest on a stint, and `confirm`, `merge`, `branch`, `return`, `pause`/`resume`/`done`/`abandon`, `reword`/`replace`/`edit`/`end`, `declare --done` and `answer --quest` refuse one. A retracted quest or stint no longer counts as an attachment for the edit-intent guard.

## [0.2.0] - 2026-10-16

### Added

- **Push sync: one history across several machines (optional).** Each machine still keeps its own `tempad.db`. With a `[sync]` section in `tempad.toml`, they all push to and pull from one self-hosted [sqld](https://github.com/tursodatabase/libsql) server. To enable it, add `[sync]` with a `url` (`libsql://`, `https://` or `wss://`; plain `http://` or `ws://` only for loopback hosts) to `TEMPAD_HOME/tempad.toml`, and put `TEMPAD_SYNC_TOKEN=<a JWT signed with the server's key>` in `TEMPAD_HOME/.env` or the environment. Plain `tempad sync` then collects, pushes and pulls; `tempad sync --push` and `--pull` (or both) run one direction only, without collecting. Without `[sync]`, tempad never opens a network connection for sync and never loads the libSQL client. Server setup (Coolify, JWT keys, backups, smoke checks) is in [`docs/deploy/sqld-coolify.md`](docs/deploy/sqld-coolify.md); the protocol and conflict rule are in `docs/specs/push-sync.md`; the README has a "Sync across machines" section. What an operator should know:
  - Events are an append-only log replayed in global `uid` order. Mirrors (GitHub, Monday, Claude sessions and messages) use last-writer-wins on `(sync_updated_at, sync_host)`, and deletes travel as tombstones. Projections are never synced: a pull that brings new events rebuilds them, and a pull that stops part-way is repaired by a durable marker on the next run.
  - `[sync].batch_size` (default 500) bounds a push or pull page; `[sync].enabled = false` turns sync off without removing the section. `[sync].url` takes no query string, fragment or `user:pass@`, and the client only ever receives a URL rebuilt from the checked parse.
  - Every host must run identical `[[projects]]` rules, because org, project and display name are synced as data.
  - A server that was lost, replaced or restored from a backup is detected and re-seeded from any one host with everything that host holds, other hosts' rows included. After restoring the server from a backup, run `DELETE FROM sync_meta WHERE key = 'server_id'` on it so every host re-seeds. A host reinstalled under the same `HOST_SLUG`, or one whose `tempad.db` was restored from an older backup, pulls its own history back instead of skipping it.
  - A host running an older tempad stops with `remote holds data from tempad schema N; upgrade tempad on this host` instead of writing into a newer database.
  - Two events with the same uid and different content are a loud error, never a silent drop.
  - `w5 backfill` and `w5 eval` classify only this host's sessions when sync is enabled, so a session pulled from another machine is never classified twice.
  - A malformed `[sync]` prints one `sync: <reason>` line and exits 1 for `tempad sync`, `w5 backfill` and `w5 eval`; it does not break commands that never sync (`w5 hook install|uninstall`, `w5 enqueue`, `w5 context`, `tempad quiet`, `tempad review`).
- **Cross-host identity merge.** Each machine ran its own `hero init`, `party add` and `client add`. When logs are combined, the first created event in uid order is canonical: one hero, one party per slug, one client per slug, one open membership per (hero, party). Later duplicates become aliases, so memberships, sagas and quests land on the canonical rows; leaving a party on one host ends only the join it names, and `tempad party leave` ends every open join. Two hosts merging a pair of quests in opposite directions cannot loop: the earlier merge in uid order wins. A single-host log records no alias and its projections are unchanged.
- `TEMPAD_SYNC_TOKEN` is a configuration variable like the others, loaded per command. Only `tempad sync` with `[sync]` enabled requires it, and `tempad setup` never prompts for it or overwrites a line you added by hand.

### Changed

- Events now carry a global `uid` (a ULID) that is the replay order instead of the local row id. Existing databases are backfilled by migration 0019 with deterministic uids, so machines that started from a copy of one `tempad.db` agree on the uids of their shared history. On a single machine the order is unchanged.
- Secrets no longer reach child processes. `MONDAY_API_TOKEN`, `TEMPAD_SYNC_TOKEN` and `GH_TOKEN` are removed from the environment of everything tempad spawns (the classifier's `claude -p`, the detached `w5 run`, `hooks/w5-common.sh`), except that the git/`gh` collector and setup's probes keep `GH_TOKEN` because `gh` reads it. Variables tempad does not own, such as `ANTHROPIC_API_KEY`, pass through.
- Every database connection now waits up to 5 seconds for a lock instead of failing at once, and opening the database no longer takes the write lock when the host slug is unchanged. Read-only commands such as `tempad report` no longer fail with `SQLITE_BUSY` while a sync, rebuild or w5 run is writing.

### Fixed

- `tempad rebuild` read the event log before taking the write lock, so an event committed by the w5 runner (or a pull) in between was missing from the projections while they were marked current. It now reads and replays inside one transaction.
- A project rule whose folder does not exist (a deleted subfolder, or a folder registered before it was created) now matches the same location reached through a symlinked parent, such as a `~/work` that points to `/work`.
- The push-sync triggers on the six mirror tables ran on every host, including hosts that never configured `[sync]`: every collected row was stamped and every deleted row left a tombstone that nothing would ever read, tripling the cost of a 20000-row insert (124 ms against 41 ms) and growing the database. The triggers now exist only once sync has run (`sync_meta('mirror_sync_enabled')`). The first `tempad sync` restamps every mirror row as written at that moment (so a row changed while sync was off is not beaten by an older version another host pushed) and installs them; with sync off, inserts, updates and deletes cost what they did before push sync, and report output is unchanged.
- The GitHub collector's reconcile step compared `gh_commits.authored_at` to the window start as text. Rows stored before commit dates were normalized to UTC keep the author's offset (`2026-09-07T23:00:00-03:00`), so one near the window boundary could be skipped and its orphaned sha (after a history rewrite) never deleted. It now compares against a UTC-normalized bound, which is valid because every stored value is UTC: migration 0021 rewrites the legacy rows, and a pull rewrites any offset-form `gh_commits` dates that older pushes left on the sync server.

### Migration

- `0019_push_sync.sql` adds the push-sync columns: `uid`, `sync_host` and `sync_dirty` on `events`, and `sync_host`, `sync_updated_at` and `sync_dirty` on the six mirror tables (`gh_repos`, `gh_commits`, `gh_pull_requests`, `monday_items`, `claude_sessions`, `claude_messages`). It also adds the triggers that stamp and dirty mirror rows and record tombstones, and the `sync_local`, `sync_cursors` and `sync_tombstones` tables. It backfills event uids on first open; nothing is sent anywhere until `[sync]` is configured.
- `0020_sync_meta.sql` adds the local `sync_meta` table, which holds the last-synced server id and the sync markers.
- `0021_normalize_commit_dates.sql` rewrites legacy offset-form `gh_commits.authored_at` and `committed_at` to UTC (`2026-09-08T02:00:00.000Z`), the form the collector writes today. Rows already in UTC are untouched, a second run changes nothing, and push-sync state (`sync_updated_at`, `sync_host`, `sync_dirty`) is left as it was.
- `0022_sync_trigger_gate.sql` drops the 18 mirror sync triggers that 0019 installs, and on a database that never synced deletes its tombstones, so a host that never configures `[sync]` pays nothing for push sync. The triggers come back on the first `tempad sync`, which also restamps every mirror row as written at that moment. A database that has already synced (non-empty `sync_meta`, a pull cursor, or anything marked pushed) keeps its triggers and every pending row, event and tombstone.

### Docs

- README: a "Sync across machines" section; the no-configuration list names `setup` (and the hidden `init` alias) and quotes the current not-set-up message.
- `docs/deploy/sqld-coolify.md`: how to self-host the sqld server on Coolify, pinned by tag and digest, with the required JWT auth, per-host tokens, backups, the restore runbook and smoke checks. An empty `SQLD_AUTH_JWT_KEY` disables auth; the page says so.
- `docs/specs/push-sync.md`: the sync design, including the audit of cross-host projection keys.
- The `quest` skill's "neither CLI exists" and "not set up" branches no longer dead-end for users without the plugin; they get the plugin route or `bun add -g @hyperlab.sh/tempad && tempad setup`. The `setup` skill finds the global bin directory with `bun pm bin -g` instead of assuming `~/.bun/bin`, and tells the user to add it to `PATH`.

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
