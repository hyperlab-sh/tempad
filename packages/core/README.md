# tempad

Reconstructs your work history, hour by hour, from git, Monday.com and Claude Code sessions into SQLite, then generates timesheet reports.

Runs on [Bun](https://bun.sh) 1.3.14 or newer.

Install the Claude Code plugin, then run `/tempad:setup` inside Claude Code:

```sh
claude plugin marketplace add hyperlab-sh/claude-plugins
claude plugin install tempad@hyperlab
```

Or use the CLI directly:

```sh
bun add -g @hyperlab.sh/tempad
tempad setup      # writes ~/.tempad/.env and tempad.toml
tempad sync
tempad report daily --from 2026-01-01 --to 2026-01-07
```

`bunx @hyperlab.sh/tempad <command>` runs it once without installing. For other agents (Codex, Cursor, etc.): `npx skills add hyperlab-sh/tempad --skill quest`.

Full documentation, configuration and the domain language are in the [repository README](https://github.com/hyperlab-sh/tempad#readme).

## License

[MIT](LICENSE)
