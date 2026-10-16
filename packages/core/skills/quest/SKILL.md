---
name: quest
description: Declare which quest this session (or subagent) is pursuing, so tempad tracks work under the right outcome instead of guessing. Use at session start, when the outcome changes, and inside every subagent before it starts work.
---

# quest

TemPad tracks the human's attention, not the agent's — declare which quest the coming work
pursues, so tempad places it under the right outcome instead of guessing.

## Glossary

- **Quest**: planned work with an outcome. A quest may _advance_ another quest (contributing
  work) or _deviate from_ one; a quest that deviates is a side quest. Never both.
- **Stint**: a stretch of your attention pursuing one quest. It starts when you begin pursuing an
  outcome and ends when that outcome is delivered, abandoned or handed off, or after an idle gap.
  Stints interleave. It lasts at least `stint_min_minutes` (default 5); shorter stretches are
  maneuvers, folded into the quest's time without a stint of their own.
- **Maneuver**: anything done inside a stint (read a file, run tests, rebase, check on a dev,
  answer a clarifying question). Never reported on its own.

Three tests for a stint: **report** (own standup/timesheet line?), **same-answer** ("what am I
finishing" doesn't change), **handoff** (over once the outcome leaves your hands; waiting isn't a
stint, checking on someone is a maneuver of the stint that handed off).

## Resolve the CLI

Before your first tempad call in this session, find the CLI once: `tempad` if `command -v tempad`
succeeds, else `bunx @hyperlab.sh/tempad` if `command -v bun` succeeds. Use that form wherever a command below
says `tempad`.

- Neither exists: tell the user to run `/tempad:setup` (it installs bun guidance and the CLI) and stop.
  Do not declare anything.
- The CLI answers `tempad is not set up yet`: tell the user to run `/tempad:setup` (or `tempad setup` in a terminal) and stop.

## Declare

`<id>` and the active quests both come from the `UserPromptSubmit` hook line at the top of each
turn: `tempad: session <id>, active quests: <title> [Q1], <title> [Q2]. Declare with
/tempad:quest (or the tempad-quest skill) if this prompt starts a different outcome.` (`none` = nothing declared). Read
it fresh each turn; do not track either yourself. Declare at session start; on every new quest
(plain re-declaration, or `--deviates-from` for a detour); inside every subagent with `--parent`;
when a quest is done (`--done`); and when one ask spans two quests, declare both — the verifier
assigns each stretch of work to whichever it belongs to.

```
tempad quest declare --session <id> --new "<title>" --outcome "<text>" --commitment personal
tempad quest declare --session <id> --quest <existing-quest-id>
tempad quest declare --session <id> --new "<title>" --outcome "<text>" \
  --deviates-from <quest id you're branching from> --trigger "<the sentence that caused the pivot>" \
  --kind waiting|blocker|curiosity|unknown
tempad quest declare --session <subagent session id> --parent <parent session id> \
  --quest <quest id> --plan "Refactor the window builder and ship it as a PR"
tempad quest declare --session <id> --done <quest>
```

`--commitment promised` for something expected delivered, `exploratory` for investigation with no
fixed deliverable, `personal` otherwise. `--new` also takes `--serves <saga id>` and, for other
work while a quest is active, `--advances <quest id>` (contributes to it) or `--deviates-from
<quest id>` (with `--trigger`/`--kind`, say what pulled you away) — never both.

## The plan

`--plan` lists the **stints** you expect, not maneuvers — apply the three tests above to each line.

- Wrong: `"read the brief; edit window.ts; run tests"` — three maneuvers of one stint.
- Right: `"Refactor the window builder and ship it as a PR"` — one stint, one outcome.

Re-declaring an active quest with a new `--plan` amends it.
