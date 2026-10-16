# tempad

Reconstructs your work history, hour by hour, from git, Monday.com and Claude Code sessions into SQLite, then generates timesheet reports.

Runs on [Bun](https://bun.sh) 1.3.14 or newer.

```sh
bunx tempad init      # writes ~/.tempad/.env and tempad.toml
bunx tempad sync
bunx tempad report daily --from 2026-01-01 --to 2026-01-07
```

To have Claude Code declare each session's quest and feed the w5 hook, install the plugin too:

```sh
claude plugin marketplace add hyperlab-sh/claude-plugins
claude plugin install tempad@hyperlab
```

Full documentation, configuration and the domain language are in the [repository README](https://github.com/hyperlab-sh/tempad#readme).

## License

[MIT](LICENSE)
