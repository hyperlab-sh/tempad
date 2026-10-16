# Contributing to TemPad

## Reporting bugs

Open a [bug report](https://github.com/hyperlab-sh/tempad/issues/new?template=bug_report.yml). Include the command you ran, the output, and the versions of Bun and TemPad.

## Suggesting features

Open a [feature request](https://github.com/hyperlab-sh/tempad/issues/new?template=feature_request.yml). Describe the problem before the solution.

## Development setup

```sh
git clone git@github.com:hyperlab-sh/tempad.git
cd tempad
bun install
bun run lint
bun test
```

[moon](https://moonrepo.dev) and [proto](https://moonrepo.dev/proto) are optional. With proto installed, `proto use` pins the same tool versions CI uses.

## Code style

- TypeScript, strict mode. Biome enforces lint and format; run `bun run lint:fix` before committing.
- Markdown, TOML and YAML are formatted by dprint: `bun run fmt`.
- Full words in identifiers. `service`, not `svc`; `details`, not `d`.
- No default values for environment variables that must be set. Throw if missing.

## Pull requests

- Branch from `main` as `feat/<short-desc>`, `fix/<short-desc>` or `chore/<short-desc>`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`.
- Add or update tests for behavior you change. CI runs lint, typecheck and tests.
- Keep PRs focused. Split unrelated changes.

## Questions

Use [GitHub Discussions](https://github.com/hyperlab-sh/tempad/discussions).
