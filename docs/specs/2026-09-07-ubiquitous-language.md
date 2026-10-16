# Ubiquitous language

**Date:** 2026-09-07. **Status:** applied.

The domain vocabulary is renamed so that no domain word can appear by accident
in ordinary prose, and every relation has exactly one verb. This batch is the
rename only; behaviour changes (minimum stint duration, multi-quest
declarations, plan grain) come in a later batch.

## The rename

| old                                | new                     | notes                                                                                                                        |
| ---------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Goal                               | **Saga**                | a direction; a quest _serves_ a saga                                                                                         |
| Activity                           | **Stint**               | a stretch of the user's attention pursuing one quest                                                                         |
| Action / Step                      | **Maneuver**            | inside a stint; docs and prompts only, nothing stored                                                                        |
| Trace                              | Trace                   | unchanged                                                                                                                    |
| Quest                              | Quest                   | unchanged                                                                                                                    |
| quest `parent` (contributes)       | quest **advances**      | relation verb; flag `--advances <quest>`                                                                                     |
| quest `origin` (side quest, nexus) | quest **deviates from** | relation verb; flag `--deviates-from <quest\|stint>`; payload field `deviates_from` (stint) or `deviates_from_quest` (quest) |
| quest → goal link                  | quest **serves**        | flag `--serves <saga>`; payload field `serves`                                                                               |

## Glossary

- **Saga**: a direction, open-ended, owned by the hero or a party. A quest
  _serves_ a saga.
- **Quest**: planned work with an outcome. A quest may _advance_ another quest
  (contributing work) or _deviate from_ one; a quest that deviates is a side
  quest and carries the nexus event. Never both.
- **Stint**: a stretch of your attention pursuing one quest. It starts when you
  begin pursuing an outcome and ends when that outcome is delivered, abandoned
  or handed off, or after an idle gap. Stints interleave. A stint contains one
  or more maneuvers. Test: would it be its own line in a standup or a timesheet?
- **Maneuver**: anything done inside a stint: read a file, run tests, rebase,
  check on a dev, answer a clarifying question. Never reported on its own.
- **Trace**: evidence of a stint, from a tool at a place at a time.
- **Declaration**: the executor stating which quest the coming work pursues.

Rule of thumb: Sagas give direction, Quests are planned, Stints are what
happened, Maneuvers are how, Traces are the proof, Places are where, Tools are
how, Projects are whose and what for.

## Relation verbs

Every relation has exactly one verb, and the flag, the payload field and the
column all carry that verb:

| relation                    | flag                      | payload field         | column                          |
| --------------------------- | ------------------------- | --------------------- | ------------------------------- |
| quest serves a saga         | `--serves <saga>`         | `serves`              | `quests.serves`                 |
| quest deviates from a stint | `--deviates-from <stint>` | `deviates_from`       | `quests.deviates_from_stint_id` |
| quest deviates from a quest | `--deviates-from <quest>` | `deviates_from_quest` | `quests.deviates_from_quest_id` |
| quest advances a quest      | `--advances <quest>`      | `advances`            | (not yet stored)                |

A `quest.branched` event's subject is always the side quest. It names what it
left either as a stint (`deviates_from`, written by `tempad quest branch <side>
--deviates-from <stint>`, the w5 classifier and `tempad answer --origin current`)
or as a quest (`deviates_from_quest`, written by `tempad quest declare --new ...
--deviates-from <quest>`, `tempad quest branch <side> --deviates-from <quest>`
and `tempad answer --origin current` when the session has no earlier stint of
the quest being left). A side quest's parent quest is
`COALESCE(deviates_from_quest_id, <that stint's quest_id>)`.

**Legacy declare shape.** Before migration 0024, `tempad quest declare --new
<side> --deviates-from <parent>` wrote the event inverted: subject = the parent,
`deviates_from` = the new side quest's id, appended at the same `at` as the side
quest's `quest.created`. The projection put a quest id into the parent's
`deviates_from_stint_id`. Events are never rewritten, so the `quests` reducer
(`branchRelation`, `src/intent/projections/quest.ts`) recognizes that signature
(a `deviates_from` naming a quest other than the subject, created at the event's
own `at`) and reads it as the new quest deviating from the subject. Any other
quest id in `deviates_from` (a hand-run `quest branch` before it learned quest
ids) reads as the subject deviating from that quest. Migration 0024 replays the
`quests` table through this reducer, so an existing database is repaired on
upgrade.

`advances` has no column yet: nothing in this codebase wrote the old `parent`
relation, so there was nothing to rename. The legacy map already translates a
`parent` payload field to `advances` if an old event carries one.

## Banned words

After this batch, none of these appear in docs, prompts, skill or CLI help:

    objective, purpose, intent, step, task, goal, activity, action, "session quest"

`outcome` is reserved for a quest's done condition. `project` stays
config-facing and never appears in a rule sentence. `outcome` replaces
`objective` as the stored field for what a quest or a stint pursues -- the
glossary reserves `outcome` for exactly this.

`stints` previously carried a _second_ column named `outcome`, set at close
time, meaning a judgment of how the stint went. Nothing ever emitted it: both
`stint.closed` writers send only `reason`, and no report rendered it. Migration
0011 drops that column, so `outcome` names one thing.

Two exceptions remain in the tree:

- **`intent`** is the name of the event-sourced layer and of `src/intent/`. It
  is a subsystem name, not a domain word, and it stays -- the layer heading in
  `CLAUDE.md`, the module path in every import, and the prose that refers to
  the layer as such. (Lead decision, 2026-09-07.) It is _not_ a licence to use
  the word as a domain term: `unknown intent command` in the CLI was reworded
  to `unknown command`, because that is user-facing runtime text about a
  command, not a reference to the layer.
- `src/intent/legacy.ts`, `src/db/migrations/*` and the history comments in
  `schema.sql` quote the old names on purpose, because that is what they are
  for.

Nothing else is exempt.

## Config keys

`tempad.toml` is hand-edited and lives outside the repository, so it cannot be
migrated the way the database is. `[w5]` keys are instead read through an
alias in `src/intent/config.ts`:

    ask_min_activity_minutes  -> ask_min_stint_minutes
    activity_idle_minutes     -> stint_idle_minutes
    memory_activities         -> memory_stints

An old key is honoured and produces one warning line naming the new key. When
both names are present the current one wins, and the warning says the old key
is ignored. A config already using current names warns about nothing. Without
this, an existing `tempad.toml` would silently fall back to defaults --
`ask_min_activity_minutes = 20` in the operator's own file happens to equal the
default, which would have hidden the breakage rather than surfacing it.

## Legacy mapping rule

Events are append-only. The database still holds rows written with the old
kinds and payload field names, and they are **not** rewritten.

Instead, every row is translated once as it is decoded, at the single read
boundary in `src/intent/store.ts` (`toRecord`), using the maps in
`src/intent/legacy.ts`:

- kinds: `activity.opened|reworded|closed|assigned` → `stint.*`,
  `goal.created|reworded|ended` → `saga.*`
- payload fields, **scoped to the kinds that actually wrote them**:

      stint.opened, stint.reworded   objective -> outcome
      quest.created                  objective -> outcome, goal -> serves
      quest.reworded                 objective -> outcome
      quest.branched                 from_activity -> deviates_from
      trace.recorded, trace.relinked activity -> stint

Payload fields are scoped by kind because they are ordinary words. A global
rename would silently rewrite any future payload that innocently used one of
these keys for an unrelated purpose. Three mappings an earlier draft carried
globally were removed after checking both `main`'s writers and the real event
log, where none of them appears:

- `goal_id` was never a payload field, only the column `quests.goal_id`;
- `origin` was only ever written _nested_ inside `quest.declared`'s `new`
  object, which the shallow translator never reached anyway;
- `parent` was never written in the quest-relation sense at all. The only
  historical `parent` is the `--parent <session-id>` CLI flag, stored under the
  distinct and still-current name `parent_session_id` — a global alias would
  have corrupted exactly that.

Reads must also match the _raw_ kind. `EventStore.read({ kind })` takes a
decoded name, but `events.kind` holds the name as written, so the query expands
it with `rawKindsFor` into `IN (<new>, <legacy…>)`. Filtering the column
directly would return nothing for every pre-rename row and quietly bypass this
boundary — the one gap that made "single read boundary" untrue.

Everything above that boundary — projections, reports, the CLI — only ever sees
the new names, and every event written from now on is written with them. A
payload that already carries the current name keeps it, so re-reading a new
event is a no-op.

`test/intent/legacy-vocabulary.test.ts` covers the decode in both directions and
rebuilds a database of old-kind events into the renamed projections.
`test/intent/legacy-chain.test.ts` goes further: it stages a database through
the real 0001-0010 chain with the pre-rename projection tables and
old-vocabulary events, runs 0011 through `openDatabase`, and asserts the
rebuild, the integrity and foreign-key checks, and that a kind-scoped read
finds the historical rows.

### `quest.declared` reads bypass this boundary, safely

`src/intent/declarations.ts` queries the `events` table directly with
`json_extract` instead of going through `EventStore`, so `translateLegacyPayload`
never runs on those rows -- and it is shallow anyway, so it would not reach the
nested `new: { ... }` object in a declaration payload.

This is safe, and stays safe, because of when the kind was introduced.
`quest.declared` post-dates every old name: the only fields read back
(`session_id`, `quest_id`, `scope`, `parent_session_id`, `plan`) have always
had exactly these names, so there is no old spelling in any stored row to
translate. Everything else a declaration displays -- the quest's title and
outcome -- is re-derived from the `quests` projection, which _is_ built through
the translated boundary.

If a future field on this payload ever needs renaming, this query is a second
read boundary and must be updated with the map, or moved onto `EventStore`.

## Migration

`0011_ubiquitous_language.sql` renames the tables and columns:

    goals                      -> sagas
    activities                 -> stints
    stints.outcome             (dropped: close-time judgment, never written)
    stints.objective           -> outcome
    traces.activity_id         -> stint_id
    trace_links.activity_id    -> stint_id
    quests.goal_id             -> serves
    quests.objective           -> outcome
    quests.origin_activity_id  -> deviates_from_stint_id

Each migration file, and its `user_version` bump, runs inside one transaction:
a failure part-way through rolls the whole file back, so the database is never
left half-renamed with the version un-bumped. (SQLite runs DDL transactionally,
so `ALTER TABLE` and `PRAGMA user_version` roll back together.)

These are projection tables, created lazily by `ensureTables` rather than by a
migration, so on a database where the intent layer was never used they do not
exist. `runMigration` (`src/db/database.ts`) therefore tolerates both
"no such table" and "no such column" for a migration file consisting only of
`ALTER`s (`ADD COLUMN`, `DROP COLUMN`, `RENAME`), and ignores SQL comment lines when splitting statements. It splits
on `;` before dropping comment lines, so a semicolon inside a comment of such a
file breaks the "only `ALTER`s" check and the file runs as one script that fails
on a missing table: keep semicolons out of migration comments. Such a
database simply gets the new names from the projection's own `createSql`.

The per-statement tolerance inside that transaction is deliberately narrow and
covers exactly two messages, both meaning "this statement has nothing to do":

- **"no such table"** — 0006, 0007, 0010 and 0011 target projection tables that
  a never-used intent layer has not created yet.
- **"no such column"** — 0011's `RENAME COLUMN`s target columns a freshly
  created projection table already has under the new name.

Every other error propagates and rolls the migration back. This is not a
general "ignore migration errors" path: skipping is safe only because these
statements are idempotent against a table the projection creates correctly from
scratch.

`tempad rebuild` after the migration reproduces the same rows.
