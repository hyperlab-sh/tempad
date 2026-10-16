---
name: setup
description: Install and configure the tempad CLI from inside Claude Code. Use when the user runs /tempad:setup, or when tempad says it is not set up yet.
disable-model-invocation: true
---

# setup

The interactive `tempad setup` wizard cannot run inside a Claude session, so do each step below
with Bash and `tempad setup --non-interactive`. Stop and report at the first step that fails.

## 1. Bun

Run `command -v bun`. If it is missing, tell the user to install it from https://bun.sh
(`curl -fsSL https://bun.sh/install | bash`), restart their shell, and run `/tempad:setup` again. Stop.

## 2. The CLI

Run `tempad --version`. If it prints a version, skip to step 3. Otherwise run
`bun add -g @hyperlab.sh/tempad`, then `tempad --version` again. If `tempad` is still not found, run
`bun pm bin -g` to get bun's global bin directory and use `$(bun pm bin -g)/tempad` by its full path
wherever a later step says `tempad`. At the end, tell the user to add that directory to their `PATH`.

## 3. Configure

If `${TEMPAD_HOME:-$HOME/.tempad}/.env` exists, ask whether to overwrite it; pass `--force` only on a yes
(the old files are kept as `.bak`).

Ask the user for each value, a few per message. Suggest defaults you can read without secrets
(`git config user.email`, `date +%Z` or their time zone, `hostname -s`, `gh api user -q .login`).

| Flag                                              | Value                                                   |
| ------------------------------------------------- | ------------------------------------------------------- |
| `--monday-api-token` (secret, `MONDAY_API_TOKEN`) | Monday personal API token                               |
| `--monday-user`                                   | Monday user id or display name                          |
| `--gh-user`                                       | GitHub login                                            |
| `--gh-orgs`                                       | Comma-separated GitHub organizations to mirror          |
| `--gh-include-personal`                           | `true` or `false`                                       |
| `--git-author-emails`                             | Comma-separated commit emails that count as theirs      |
| `--claude-dirs`                                   | Comma-separated Claude config dirs, usually `~/.claude` |
| `--host-slug`                                     | Short name for this machine                             |
| `--tz`                                            | IANA time zone, e.g. `Europe/Berlin`                    |
| `--since`                                         | Earliest date to sync, `YYYY-MM-DD`                     |
| `--gh-token` (secret, `GH_TOKEN`, optional)       | Leave unset to use `gh auth` credentials                |

Secrets (the Monday token, the GitHub token):

- Never repeat, quote, summarize or echo a secret, in text or in a command's output. Never use `echo`, `cat`
  or `env` on one.
- Do not put a secret in a flag (flags show up in process lists). Pass it as an environment variable on
  the command, e.g. `MONDAY_API_TOKEN='<token>' tempad setup ...`. The CLI reads `MONDAY_API_TOKEN` and
  `GH_TOKEN` from the environment when the flag is absent.
- If the variable is already set in their environment (`[ -n "${MONDAY_API_TOKEN:-}" ]`, which prints
  nothing), do not ask for it.

Then run:

```sh
MONDAY_API_TOKEN='<token>' tempad setup --non-interactive --monday-user <id> --gh-user <login> \
  --gh-orgs <orgs> --gh-include-personal <true|false> --git-author-emails <emails> \
  --claude-dirs <dirs> --host-slug <slug> --tz <zone> --since <date> [--force]
```

The command validates the values (including a live check of the tokens) and prints secrets as `set`
only. On `missing required value(s)` or a failed check, tell the user which variable and ask again;
add `--no-verify` only if they say the check cannot run here (offline).

## 4. Verify

Run `tempad saga list` (read-only; it fails with `tempad is not set up yet` if the files were not
written). Then tell the user setup is done and the next steps: `tempad hero init "<name>"` and
`tempad sync`.
