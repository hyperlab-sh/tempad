# w5 inferred output as an overwritable projection plus a memoized oracle

Design note for tempad-7bq (P3). Agreed shape with the operator on 2026-10-18:
human intent stays event-sourced; machine inference becomes an overwritable,
deterministic projection fed by a memoized classification oracle. This note
refines that shape, answers sync, and sketches the migration. No code here.

## 1. Current state

`EVENT_KINDS` (`packages/core/src/intent/events.ts`) holds 42 kinds. Split by
who authors them in practice:

**Human intent** (authored by the hero through the CLI, the `quest` skill, or
`tempad answer`; these are the facts worth syncing): `hero.created`,
`party.created`/`party.reworded`, `membership.joined`/`membership.left`,
`client.created`, `project.created`/`project.updated`, `place.opened`/
`place.closed`, `saga.*`, `quest.created` (declared mode), `quest.reworded`,
`quest.ended`, `quest.confirmed`, `quest.merged`, `quest.branched`,
`quest.returned`, `quest.declared`, `agent.spawned`, `stint.assigned`,
`question.answered`, `impact.stated`, `session.kind_set`, `quest.lifecycle`,
and `retracted` when a person issues it (`quest retract`).

**Inference output** (appended by w5 machinery): `stint.opened`, `stint.closed`
(`src/w5/lifecycle.ts:76,114`), `stint.dismissed` (`lifecycle.ts:39`),
`stint.continuation_cleared` (`src/w5/reset.ts`), `trace.recorded` and
`trace.relinked` (`src/intent/api.ts:90,129`, called from `applyResult`),
`question.asked`/`question.watched`/`question.promoted`/`question.expired`
(`api.ts:157`, `src/w5/questions.ts`), `window.classified`
(`src/w5/backfill.ts:600`), `session.kind_inferred`
(`src/sessions/kind.ts`), `quest.created`/`quest.branched` on the inference
path (`src/w5/apply.ts:114,137`), and `retracted` when `w5 dedupe`/`reset`
issues it (`src/w5/dedupe.ts`, `src/w5/reset.ts`). That is roughly two thirds
of the kind list and, by row count, almost all of `events`.

**Volumes.** No populated fixture database exists (`test/fixtures/` holds git,
github, monday, legacy, report-golden and usage-literals fixtures; none is a
populated `events` store), so exact counts would have to come from
`~/.tempad`, which this task may not touch. The whole-system evaluation of
2026-10-18 (the audit that produced the tempad-lfv/v5j/9ol/m7d/l1a/7b2 beads)
counted on the real database: 4554 live stints (598 quest-less), 503 quests
(102 confirmed), 616 of 643 sessions never declaring a quest. Every stint is
one `stint.opened` plus close/dismiss events; every trace segment is one
`trace.recorded` (a stint typically holds several), and every classified
window is one `window.classified`. Extrapolating, inference kinds account for
on the order of 20k+ events against a few thousand human-intent ones — and
they are rewritten wholesale whenever the classifier improves, which is the
problem this note addresses.

**Rebuild.** Every projection replays `events` in uid order
(`src/intent/projections/register.ts`, `ALL_PROJECTIONS`): the stint
projection owns `stints`/`traces`/`questions` from `stint.*`/`trace.*`/
`question.*` events (`src/intent/projections/stint.ts`), the window
projection owns `w5_windows` (from `window.classified`) and
`w5_stale_windows` (from `quest.declared`, `projections/window.ts`). So
inference output is currently treated as fact: `tempad rebuild` reproduces it,
and a bad run is repaired only by appending more events — retractions
(`src/w5/dedupe.ts`, `src/w5/reset.ts`, per-item `quest retract`) — exactly
the machinery PR #83 (`--reclassify` removal) pruned.

**Sync.** `src/sync/tables.ts` pushes one append table, `events`, plus six
collector mirrors (`gh_repos`, `gh_commits`, `gh_pull_requests`,
`monday_items`, `claude_sessions`, `claude_messages`). Because inference
output lives in `events`, today the classifier's judgments cross hosts as
facts, and `w5 backfill`/`w5 eval` filter by `host_slug`
(`src/w5/backfill.ts`) precisely so two hosts do not classify the same
session.

## 2. Target model

### 2.1 Tables

- **`w5_classification_cache`** — the oracle memo. Columns:
  `window_id` (see below), `input_hash` (see below), `classifier_version`
  (integer, from the existing version constant pattern in
  `src/sessions/kind.ts`), `result_json` (the validated `ClassifierResult`,
  post-`validateResult`), `classified_at`, `host_slug`.
  Primary key `(window_id, input_hash, classifier_version)`. A re-run of the
  same window under a different version or input adds a row; nothing is ever
  retracted. Reading picks the row matching the current version, else the
  newest older one is simply ignored (miss → call the oracle).
  `window_id` is `(session_id, started_at, ended_at)` — the chunk bounds
  `chunkByWindow` already computes (`src/w5/backfill.ts`) — stored as three
  columns rather than a composite string so coverage queries stay indexable.
- **Derived w5 tables** — `stints`, `traces`, `questions`, `w5_windows`
  change meaning: for inference-origin rows they are no longer replayed from
  events but **computed** by a deterministic pass over (collector facts +
  human-intent events + cache rows), in the shape `applyResult` already has:
  same segment→stint resolution, same lifecycle rules (`lifecycle.ts`), same
  question hand-back rules (`questions.ts`), minus the `store.append` calls.
  The tables keep their current columns plus `source TEXT` (`'event'` for
  legacy rows, `'derived'` for computed ones) so the two populations coexist
  during migration. `w5_stale_windows` disappears as a stored table; it
  becomes a query over declarations, which it already is conceptually
  (`projections/window.ts`).
- **Inferred quests** (inference mode's `proposedQuest`) become rows of a
  derived `quests_inferred` table (same columns as `quests` minus sync
  columns). A `quest confirm` (existing human event) promotes one to a real
  `quest.created` fact; until then it is a local proposal that rebuild
  recomputes. Declared-mode quests are already facts and stay so.

### 2.2 Input hash

`input_hash = sha256(canonical_json(...))` over exactly what
`buildWindow` (`src/w5/window.ts`) feeds the prompt plus what `validateResult`
and `applyResult` consume, in a fixed field order:

1. window identity: `session_id`, `started_at`, `ended_at`, `mode`;
2. messages: for each, `uuid`, `ts`, `origin`, `origin_kind`, the 500-char
   preview text the database keeps (`claude_messages`), in row order;
3. overlap tail message `uuid`s (context, not classified — but changing the
   tail changes the prompt, so it hashes);
4. the memory slice inputs as **stable summaries**: for each session-open and
   recent stint `(stint_id_hash, quest_id_hash, outcome_hash, state)`, for
   each active quest `(quest_id_hash, title_hash, plan item hashes)`; hashes
   of ids/texts, not the text, so the memo never stores user prose;
5. `previous_session_note` hash;
6. `classifier_version` and the prompt-relevant `[w5]` settings
   (`overlap_messages`, `memory_*`, mode).

Anything not on this list (stint ids opened by the same window, say) cannot
change the answer by construction, so it must not be in the hash — otherwise
the memo never hits. The hash is defined over the *inputs*; the memo key adds
`input_hash` and `classifier_version` so a prompt or model change invalidates
everything without touching the rows.

### 2.3 Protection predicate

A derived stint is **protected** iff any of:

- it was opened in declared mode against a `quest.declared` quest (its quest
  is declared-origin — `quests.origin_kind`);
- its quest is confirmed (`quest.confirmed` event exists);
- any of its traces has a `question.answered` event;
- a human `stint.assigned` names it.

Protected rows are pinned: the deterministic pass keeps the stored row and its
traces exactly as they are, and a cache re-run for a window overlapping a
protected span writes only the non-protected remainder. This is the same
protection set `resolveStaleWindows` enforces today
(`src/w5/stale.ts`: confirmed, declared, or `quest.declared`-named quests are
never retracted), restated as a predicate instead of a retraction filter.

### 2.4 `rebuild` and `scry`

- **`tempad rebuild` keeps cache rows untouched.** They are data (an oracle
  memo), not a projection of events; rebuilding them would mean re-asking the
  model, which rebuild must never do. The stint/trace/question tables are
  truncated and recomputed: replay of legacy events for `source='event'`
  rows, then the deterministic pass for derived rows.
- **`tempad scry`** (`src/scry/replay.ts`, `compareProjectionsToReplay`):
  the events-only replay target gains the cache table copied verbatim, so the
  derived pass runs identically there and the compare stays exact. `--fast`
  skips it as today.

## 3. Sync answer

**Recommendation: host-local cache, derived everywhere, promotion to fact on
human confirmation. "Events are the only thing that crosses hosts" holds.**

- Sessions live on one host (the host that ran them; `claude_sessions` syncs
  as a mirror, but only the owning host's w5 pass classifies them — that is
  already true via the `host_slug` filter in `backfill.ts`). So the natural
  owner of the cache row and of the derived rows is that host.
- A second host receives all facts (mirrors + events) and can *recompute* the
  derived tables only if it also holds cache rows — which, under this
  recommendation, it does not. What it sees instead: quests created by
  inference are absent until confirmed (confirmation is an event and syncs);
  traces/inferred stints are absent; `tempad review` and reports on that host
  show declared-mode work, sessions, commits and Monday items, but not
  another host's inferred attribution. That is the honest cost.

The alternatives, and what they break:

| Option | Second host gets | What breaks |
|---|---|---|
| A. host-local cache (recommended) | facts + human events only | inferred stints/traces/quests invisible off-host until confirmed; reports per-host |
| B. cache as its own sync channel (synced-upsert table, last-writer-wins) | everything | breaks "only events cross hosts": a new table class in `sync/tables.ts`, tombstones for cache rows, and two hosts classifying the same session (backup restored, reinstalled host slug) overwrite each other's memos with no merge story |
| C. derived on each host by re-running the oracle | everything, eventually | every host pays full classification cost for every session; the claude-cli backend uses the operator's subscription per host; answers can differ per host, so "derived" is not deterministic across hosts — it is a second opinion, not a projection |

B and C buy cross-host inferred minutes at the cost of either a second sync
truth or N× classification spend. Inferred output is disposable by premise;
the minutes that matter for a timesheet survive through confirmed quests and
session facts, both of which sync. If cross-host inferred minutes ever become
a hard requirement, the right move is B limited to the cache table (it is
purely a memo — a wrong row never corrupts a fact), which can be added later
without disturbing the event stream. Nothing in this design blocks it.

## 4. Cascade and re-run semantics

**Cascade rule: invalidation propagates forward within the session only.**
Cross-session staleness (a merge/reword/retract that changes a candidate used
by another session's already-classified window) is tolerated: those windows
re-run lazily on the next trigger in their own session, or on a
`classifier_version` bump. Defense: sessions are the unit of human attention,
windows are cheap to re-run (memo hits), and a global cascade would re-run
thousands of windows for a quest title edit — the exact "bulk retract"
failure mode PR #83 removed. A merge changes what a window *should have
matched*; under the projection model that is a display staleness, not a data
corruption, because nothing is a fact until confirmed.

| Trigger | Invalidated | Re-run when | Cost |
|---|---|---|---|
| new messages in the session | windows whose `ended_at` could extend; next window | live hook / next backfill | one oracle call (memo miss) |
| `quest.declared` on the session | every window before the declaration's coverage start (`w5_stale_windows` logic, `projections/window.ts`) | next backfill run picks stale windows | forward-in-session re-runs; memo may hit if hash unchanged (declarations are in the hash, so it misses — correct) |
| `question.answered` / `stint.assigned` | windows overlapping the protected span | next backfill or explicit `w5 rerun --session` | protected rows pinned; only remainder rewritten |
| quest merged / retracted / ended / reworded (candidate change) | this session's windows naming the quest; *other* sessions' windows naming it stay stale, tolerated | lazy: their own next trigger, or version bump | none until touched |
| `classifier_version` bump | all windows (new memo key) | next backfill over the range | full reclassification; the old memo rows remain for diffing |

Worked examples, one per trigger:

1. **New material.** A session grows; the hook enqueues; the runner's next
   window starts after the last classified one. Its hash is new; oracle runs
   once; earlier windows of the session are untouched (their hashes are
   unchanged because their inputs exclude later messages — the memory slice
   is bounded by `windowEnd`, already enforced in `window.ts`).
2. **Late declaration.** `quest declare --since <start>` at session end marks
   the session's earlier windows stale, exactly as `w5_stale_windows` does
   today; backfill re-runs them; protected traces (none here — nothing was
   human-touched) are simply replaced; the old stints/traces vanish because
   they were derived rows, with zero `retracted` events.
3. **Human correction.** `tempad answer --belongs <question>` pins the stint
   and its traces; the overlapping window re-runs on next backfill and its
   cache row is *added* under a new hash, but the deterministic pass keeps
   the pinned rows and merges the new segments around them.
4. **Candidate change.** Quest A is merged into B. This session's windows
   that named A re-run and land on B. A different session's window that
   matched A last week keeps showing A until its own next trigger — visible
   in reports as the old title, never as wrong minutes, because trace bounds
   did not change.
5. **Version bump.** The prompt or model changes; `classifier_version`
   increments; `w5 backfill --from <oldest>` re-runs every window in range
   with a guaranteed memo miss; protected rows survive everywhere; the diff
   between memo versions is auditable from the cache table itself.

## 5. Migration sketch

From SCHEMA_HEAD 28 (`0028_title_vague.sql`; confirmed in
`src/db/migrations/`):

1. **Migration 0029** creates `w5_classification_cache` and `quests_inferred`
   with the columns of §2.1; adds `source` columns to `stints`/`traces`/
   `questions` defaulting to `'event'`; drops `w5_stale_windows` (its rows
   are recomputed as a query). TypeScript step classifies the new tables in
   `sync/tables.ts` as local-only (cache is host-local per §3;
   `quests_inferred` is derived).
2. **Existing inference events: keep as history, stop appending.**
   Converting them to cache rows is not possible: a cache row needs
   `result_json` (the classifier's full validated answer) and `input_hash`,
   neither of which is reconstructible from `trace.recorded`/`stint.opened`
   events — the segments were already resolved. Legacy rows therefore stay as
   `source='event'` rows replayed by rebuild forever. Cost: `events` keeps
   its bulk; benefit: zero-risk cutover, nothing is rewritten, and the
   append-only trigger (`events_no_update`) is untouched.
3. **Cut the writers over**: `applyResult` (`src/w5/apply.ts`) stops calling
   `store.append` for inference kinds and writes a cache row + lets the
   deterministic pass derive; `lifecycle.ts` events (`stint.closed`/
   `stint.dismissed`) become rules of the pass; `backfill.ts` stops appending
   `window.classified` (coverage becomes a cache query); `refreshSessionKinds`
   stops appending `session.kind_inferred` (its rows were already local-only
   per migration 0027's sync registry). Human kinds — `quest.declared`,
   `question.answered`, `stint.assigned`, `retracted` by a person — keep
   appending.
4. **`tempad rebuild` during transition** replays legacy events and then runs
   the deterministic pass over cached windows, in one transaction as today
   (`rebuildAll`, `src/db/database.ts`). An event-only rebuild
   (`rebuild --until` before the cutover) reproduces legacy rows and no
   derived ones — acceptable, and `stateAsOf` matches by the same rule.
5. **Repair becomes a re-run**: a bad run is fixed by bumping
   `classifier_version` (or a targeted `w5 backfill --from <date> --session
   …`) which overwrites the derived rows in place. What goes away:
   `--reclassify` (already removed, stays gone), `--force` on
   `w5 backfill` (superseded by version bump / hash change), `w5 dedupe`
   (duplicate windows cannot happen — a window has one cache row per key),
   and the retraction cascades in `dedupe.ts`/`reset.ts` shrink to legacy
   cleanup (`w5 eval`'s reset becomes "delete derived rows in range", not
   event surgery). Per-item `quest retract` stays: quests it retires are
   facts.

## 6. Risks and open questions

1. **Derived-pass drift**: the deterministic pass must reproduce what
   `applyResult` does today, and the two will drift while both exist.
   Default: port `applyResult`'s resolution rules into the pass behind the
   same tests (`test/w5/apply*`), delete the event-writing path in the same
   bead, never keep both writable.
2. **Memo poisoning**: a cache row keyed by a hash that under-specifies its
   inputs (a missing field) silently replays a wrong answer forever.
   Default: include a `hash_version` inside `input_hash` and bump it with any
   change to `buildWindow`'s outputs; scry gains a check that recomputes N
   sampled hashes.
3. **Cross-session staleness visible in reports** (§4). Default: accept, and
   have `tempad scry` count stale-by-candidate-change windows so the operator
   sees the number.
4. **Off-host inferred minutes vanish** (§3, option A cost). Default: accept
   until a real report needs it; the escape hatch (sync the cache table) is
   additive.
5. **Legacy dual-source rows in one table** (`source` column) complicate
   every query. Default: keep for one minor version, then a cleanup
   migration re-derives legacy windows once under the then-current version
   and drops `source='event'` inference rows from the projections (events
   themselves stay, per append-only).

## 7. Scope for implementation

Beads to create, in order:

1. **tempad-7bq-a (M): classification cache table + oracle memo.** Migration
   0029 (cache + `source` columns), `classify` goes through the memo,
   `w5 eval` counts hits/misses. No behavior change yet.
2. **tempad-7bq-b (L): deterministic derived pass.** Port `applyResult` +
   `lifecycle.ts` rules into a pass over cache rows; `stints`/`traces`/
   `questions` gain derived rows; protection predicate enforced; rebuild and
   scry updated (§2.4).
3. **tempad-7bq-c (M): cut over the writers.** `applyResult`/`backfill.ts`
   stop appending inference events; `w5_windows` coverage from cache;
   `--force` and `w5 dedupe` removed; `w5 eval` reset simplified.
4. **tempad-7bq-d (S): inferred quests as proposals.** `quests_inferred`
   table, `quest confirm` promotes, reports render proposals with a marker.
5. **tempad-7bq-e (S): re-run triggers and stale reporting.** Lazy re-run on
   candidate change, scry staleness counters, hash_version bump discipline.
6. **tempad-7bq-f (S, deferred): sync the cache table** if cross-host
   inferred minutes become a requirement (§3 escape hatch).
