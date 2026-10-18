import type { Database } from "bun:sqlite";
import { askQuestion, assignStint, recordTrace } from "../intent/api";
import { latestDeclaredParentSessionId } from "../intent/declarations";
import type { Actor } from "../intent/events";
import { currentHeroId } from "../intent/identity";
import { newUlid } from "../intent/ids";
import { applyIncremental } from "../intent/projections";
import type { EventStore } from "../intent/store";
import {
  type ClassifierResult,
  type ClassifierSegment,
  type ClassifierWindow,
  DEFAULT_NEW_STINT_REASON,
  parseSegmentReference,
  UNRECOGNIZED_QUEST_ALIAS_GUESS,
} from "./classifier";
import { openStintContinuing } from "./lifecycle";

export interface AppliedSummary {
  traces: number;
  stintsOpened: number;
  questsProposed: number;
  branches: number;
  questionsWatching: number;
  /**
   * Declared mode: segments the verifier doubted (`belongs: false`). Inference
   * mode: the old quest-conflict count. A run is one mode or the other, so the
   * two meanings never coexist in the same summary.
   */
  doubts: number;
  /**
   * Declared mode: doubts recorded and logged but never asked, because the
   * segment carried no quoted trigger or named an unrecognized quest alias.
   * Counted whether or not asking is enabled; a subset of `doubts`.
   */
  doubtsSilent: number;
  unknownStintIds: number;
  /**
   * Inference mode: segments whose quest/stint selectors were repaired because
   * the model put a quest id where a stint id belongs or the reverse
   * (`normalizeInferredSelectors`).
   */
  selectorRepaired: number;
  /**
   * A matched stint that had no quest, for which the classifier proposed one.
   */
  questProposedOnMatched: number;
  /**
   * A matched stint that had no quest, for which the classifier named an open
   * quest the window offered, now attached to it.
   */
  questAttachedOnMatched: number;
  /**
   * Inference mode: segments that landed on a stint or quest an earlier segment
   * of the same window opened or reached, through a `"segment:<n>"` reference,
   * the same-outcome rule (`isSwitch: false` with no stint named) or a repeated
   * proposed quest title (`resolveWithinWindow`).
   */
  sameWindowReuse: number;
}

export interface ApplyOptions {
  actor: Actor;
  askingEnabled: boolean;
  now: string;
  log: (line: string) => void;
  /**
   * `"declared"` runs the verifier: quest identity comes from the session's own
   * declaration and no quest is ever created, proposed, reassigned or branched
   * here. `"inferred"` runs the pre-verifier logic unchanged, which backfill
   * falls back to for a session that never declares anything.
   */
  mode?: "declared" | "inferred";
  /**
   * A `declare` question is exactly as premature as a stint would be for the
   * same stretch: below this many minutes of undeclared segment time, the
   * window's "no declaration yet" gap is recorded but not asked about.
   */
  stintMinMinutes: number;
}

function requireHeroId(database: Database): string {
  const id = currentHeroId(database);
  if (!id) throw new Error("run `tempad hero init` first");
  return id;
}

function classifyTrigger(trigger: string | null): string {
  if (trigger === null) return "unknown";
  const lower = trigger.toLowerCase();
  if (/\bblocked\b|\bfailing\b|\berror\b/.test(lower)) return "blocker";
  if (/\bwhy\b|\bwonder\b|\bwhat does\b/.test(lower)) return "curiosity";
  if (/\bwaiting\b|\bwhile.*(runs?|running)\b|\bin the meantime\b/.test(lower)) return "waiting";
  return "unknown";
}

function createQuest(
  store: EventStore,
  database: Database,
  input: {
    heroId: string;
    title: string;
    outcome: string;
    commitment: string;
    confirmed: boolean;
  },
): string {
  const id = newUlid();
  applyIncremental(
    database,
    store.append({
      actor: "hook",
      kind: "quest.created",
      subject: id,
      payload: {
        owner: { kind: "hero", id: input.heroId },
        title: input.title,
        outcome: input.outcome,
        commitment: input.commitment,
        confirmed: input.confirmed,
      },
    }),
  );
  return id;
}

function branchQuest(
  store: EventStore,
  database: Database,
  input: { questId: string; fromStintId: string; trigger: string; at: string },
): void {
  applyIncremental(
    database,
    store.append({
      actor: "hook",
      kind: "quest.branched",
      subject: input.questId,
      at: input.at,
      payload: {
        deviates_from: input.fromStintId,
        trigger: input.trigger,
        kind: classifyTrigger(input.trigger),
      },
    }),
  );
}

interface ResolvedStint {
  stintId: string;
  questId: string | null;
  stintOpened: boolean;
  questCreated: boolean;
  questConflict: boolean;
  unknownStintId: boolean;
  questProposedOnMatched: boolean;
  questAttachedOnMatched: boolean;
}

/**
 * What a segment may attach a quest to: the open quests and this session's open
 * stints the window offered.
 */
interface AttachTargets {
  questIds: ReadonlySet<string>;
  stintIds: ReadonlySet<string>;
}

interface StintState {
  questId: string | null;
  isOpen: boolean;
}

/**
 * Reads a stint the classifier named, ignoring retracted rows. A classifier
 * can return an id that never existed, belongs to another session, or was
 * retracted since the slice was built, so every id it hands back is looked up
 * before it is trusted.
 *
 * With `through` (the instant the segment ends) a stint that closed at or after
 * it counts as open: it was still open for the whole stretch of work, which is
 * how `buildWindow` offered it when later windows were already classified (a
 * `--force` re-run or a `w5 eval` rerun). Opening a `continues` stint there would
 * overlap the stint it continues. A stint that closed *inside* the segment is not
 * open: reusing it would put a trace past its own `closed_at`, so the segment
 * continues it instead.
 */
function readStint(database: Database, stintId: string, through?: string): StintState | null {
  const row = database
    .query(
      "SELECT quest_id as questId, closed_at as closedAt FROM stints WHERE id = ? AND retracted_at IS NULL AND dismissed_at IS NULL",
    )
    .get(stintId) as { questId: string | null; closedAt: string | null } | null;
  if (!row) return null;
  return {
    questId: row.questId,
    isOpen: row.closedAt === null || (through !== undefined && row.closedAt >= through),
  };
}

function resolveQuest(
  store: EventStore,
  database: Database,
  heroId: string,
  segment: ClassifierSegment,
): { questId: string | null; questCreated: boolean } {
  const matchedQuest = segment.matchedQuest ?? null;
  const proposedQuest = segment.proposedQuest ?? null;
  if (matchedQuest !== null) return { questId: matchedQuest, questCreated: false };
  if (proposedQuest === null) return { questId: null, questCreated: false };
  return {
    questId: createQuest(store, database, {
      heroId,
      title: proposedQuest.title,
      outcome: proposedQuest.outcome,
      commitment: proposedQuest.commitment,
      confirmed: false,
    }),
    questCreated: true,
  };
}

/**
 * Reuse of a stint that already exists (matched, or `continues` pointed at a
 * still-open one). Its quest is never reassigned, but the classifier's opinion is
 * read for what it is:
 *
 * - `matchedQuest: null` is *no opinion*, not "no quest". A model that omits the
 *   field means it did not judge the quest, so the stint keeps its own and
 *   nothing is reported -- treating this as a disagreement made almost every
 *   segment a conflict.
 * - a different non-null `matchedQuest` is a real disagreement: counted, logged,
 *   never applied.
 * - `proposedQuest` on a matched stint that has *no* quest is a case where
 *   something is missing rather than contested, so the quest is created and
 *   attached through the ordinary `stint.assigned` path.
 * - so is a non-null `matchedQuest` on a stint with *no* quest: there is nothing
 *   to disagree with, and leaving it unattached left the stint's traces
 *   unattributed and the same doubt repeating every window. The quest is attached
 *   the same way, but only when it is one of the open quests the window offered
 *   and the stint is one of this session's open stints the window offered
 *   (`attachable`); otherwise it stays a doubt. A quest id outside the list
 *   (garbled, abandoned, merged) and a stint of another session or project, or
 *   one the window never offered, are not this segment's to claim.
 *
 *   Attaching is not local to the segment: `traces` carry no quest of their own,
 *   they take it from their stint, so one segment's `matchedQuest` puts every
 *   earlier trace of the stint under that quest too. That is the point (they were
 *   unattributed), and why it is limited to this session's stints; it is counted
 *   (`questAttachedOnMatched`) and logged, never silent.
 */
function reuseStint(
  store: EventStore,
  database: Database,
  heroId: string,
  segment: ClassifierSegment,
  stintId: string,
  existingQuestId: string | null,
  attachable: AttachTargets,
): ResolvedStint {
  const matchedQuest = segment.matchedQuest ?? null;
  const proposedQuest = segment.proposedQuest ?? null;

  if (
    existingQuestId === null &&
    matchedQuest !== null &&
    attachable.questIds.has(matchedQuest) &&
    attachable.stintIds.has(stintId)
  ) {
    assignStint(store, database, stintId, matchedQuest, "hook");
    return {
      stintId,
      questId: matchedQuest,
      stintOpened: false,
      questCreated: false,
      questConflict: false,
      unknownStintId: false,
      questProposedOnMatched: false,
      questAttachedOnMatched: true,
    };
  }

  const questConflict = matchedQuest !== null && matchedQuest !== (existingQuestId ?? null);

  if (existingQuestId === null && matchedQuest === null && proposedQuest !== null) {
    const questId = createQuest(store, database, {
      heroId,
      title: proposedQuest.title,
      outcome: proposedQuest.outcome,
      commitment: proposedQuest.commitment,
      confirmed: false,
    });
    assignStint(store, database, stintId, questId, "hook");
    return {
      stintId,
      questId,
      stintOpened: false,
      questCreated: true,
      questConflict: false,
      unknownStintId: false,
      questProposedOnMatched: true,
      questAttachedOnMatched: false,
    };
  }

  return {
    stintId,
    questId: existingQuestId,
    stintOpened: false,
    questCreated: false,
    questConflict,
    unknownStintId: false,
    questProposedOnMatched: false,
    questAttachedOnMatched: false,
  };
}

/**
 * A repaired segment is a guess about what the model meant, so its confidence is
 * capped. The cap is bookkeeping, not a signal: the low-confidence list in
 * reports uses `< 0.5`, so a capped segment never appears in it, and nothing else
 * reads `confidence`. `selectorRepaired` is the signal that repairs happened.
 */
const REPAIRED_CONFIDENCE_CAP = 0.5;

/**
 * Inference mode lists quests and stints by their 26-character ULIDs in one
 * prompt, and the model mixes the two up: the 2026-10-18 backfill logged 345
 * `w5 unknown stint id` lines and 236 of them named a *quest* in a stint slot
 * (a stint id sat in `matchedQuest` as well). Every such segment opened an
 * unlinked stint, so one stretch of work became a stint per window.
 *
 * Every repaired id is resolved against the window's own candidate lists only
 * (`sessionOpenStints`, `recentStints`, `openQuests`), never the database: those
 * are bounded by `windowEnd` and filtered by state, so a repair cannot reach a
 * stint opened after the segment, a quest that was abandoned or merged, or
 * another session's open stint. The lists are also what the model was shown, so
 * an id outside them (garbled, another table's) is not a mix-up and stays
 * unknown.
 *
 * - A quest named in `matchedStint`/`continuesStint` is read as "this quest's
 *   work continues": the session's open stint of that quest is reused, else
 *   the most recent closed stint of that quest in `recentStints` (the project's,
 *   so possibly another session's: the prompt offers those to resume too) is
 *   continued, else a new stint is opened. The quest becomes `matchedQuest` when none was given. When
 *   `matchedQuest` names a *different* quest the segment keeps that one and the
 *   stint slot is dropped, so a new stint never links across quests.
 * - A stint named in `matchedQuest` stands for that stint's quest, so the normal
 *   conflict check against `matchedStint` still runs. It is promoted to the
 *   stint selector only when the segment named none and its reason is the
 *   defaulted one (an explicit `newStintReason` is the model's own judgement),
 *   and only for this session's open stint or a closed one.
 */
function normalizeInferredSelectors(
  window: ClassifierWindow,
  segment: ClassifierSegment,
): { segment: ClassifierSegment; repairs: string[] } {
  const repairs: string[] = [];
  let matchedStint = segment.matchedStint ?? null;
  let continuesStint = segment.continuesStint ?? null;
  let matchedQuest = segment.matchedQuest ?? null;
  let newStintReason = segment.newStintReason ?? null;

  const sessionOpen = new Map(window.sessionOpenStints.map((stint) => [stint.stintId, stint]));
  const recent = new Map(window.recentStints.map((stint) => [stint.stintId, stint]));
  const stintQuest = (id: string): string | null | undefined =>
    (sessionOpen.get(id) ?? recent.get(id))?.questId;
  const isStint = (id: string): boolean => sessionOpen.has(id) || recent.has(id);
  const openQuestIds = new Set((window.openQuests ?? []).map((quest) => quest.id));

  if (matchedQuest !== null && !openQuestIds.has(matchedQuest) && isStint(matchedQuest)) {
    const named = matchedQuest;
    const closedOrOwn = sessionOpen.has(named) || recent.get(named)?.closedAt !== null;
    const promotable =
      matchedStint === null &&
      continuesStint === null &&
      (newStintReason === null || newStintReason === DEFAULT_NEW_STINT_REASON) &&
      closedOrOwn;
    if (promotable) {
      if (sessionOpen.has(named)) matchedStint = named;
      else continuesStint = named;
      newStintReason = null;
    }
    // The stint's quest stands in only while it is an open candidate: a closed
    // stint of an abandoned or merged quest must not put that quest back.
    const namedQuestId = stintQuest(named) ?? null;
    matchedQuest = namedQuestId !== null && openQuestIds.has(namedQuestId) ? namedQuestId : null;
    repairs.push(`matchedQuest named stint ${named}`);
  }

  const namedQuest = [matchedStint, continuesStint].find(
    (id): id is string => id !== null && !isStint(id) && openQuestIds.has(id),
  );
  if (namedQuest !== undefined) {
    matchedStint = null;
    continuesStint = null;
    if (matchedQuest === null || matchedQuest === namedQuest) {
      const open = window.sessionOpenStints
        .filter((stint) => stint.questId === namedQuest)
        .sort((left, right) => (left.openedAt < right.openedAt ? 1 : -1))[0];
      const closed = window.recentStints.find(
        (stint) => stint.questId === namedQuest && stint.closedAt !== null,
      );
      if (open !== undefined) matchedStint = open.stintId;
      else if (closed !== undefined) continuesStint = closed.stintId;
      matchedQuest = namedQuest;
    }
    repairs.push(`stint selector named quest ${namedQuest}`);
  }

  if (repairs.length === 0) return { segment, repairs };
  if (matchedStint === null && continuesStint === null && newStintReason === null) {
    newStintReason = "classifier named a quest, no stint of it to continue";
  }
  return {
    segment: {
      ...segment,
      matchedStint,
      continuesStint,
      matchedQuest,
      newStintReason,
      confidence: Math.min(segment.confidence, REPAIRED_CONFIDENCE_CAP),
    },
    repairs,
  };
}

/** Where each earlier segment of this window landed, and the quests it proposed. */
interface WindowLedger {
  landed: { stintId: string; questId: string | null }[];
  /** Quests this window created from `proposedQuest`, by `proposalKey`. */
  proposedQuests: Map<string, string>;
}

/**
 * Two proposals are one quest when both the title and the outcome match: a
 * generic title ("Bug fixes") proposed twice for different outcomes is two quests.
 */
function proposalKey(proposed: { title: string; outcome: string }): string {
  return `${normalizeOutcome(proposed.title)}\n${normalizeOutcome(proposed.outcome)}`;
}

/** Whether a stint slot's reason is the model's own, not the one `validateResult` defaulted. */
function explicitReason(segment: ClassifierSegment): string | null {
  const reason = segment.newStintReason ?? null;
  return reason === null || reason === DEFAULT_NEW_STINT_REASON ? null : reason;
}

/**
 * Inference mode lists only rows that existed before the window, by id, so a
 * stint or quest opened by segment 1 has no id segment 2 could name. The model
 * then had nothing to say "still the same stretch" with: on 2026-10-04 one window
 * of e854515d came back as four segments that all named the same quest, set
 * `isSwitch: false`, and explained in `newStintReason` that "review feedback is
 * part of the same brief execution; no separate stint needed", and each opened
 * its own stint; in another run segment 1 proposed the quest and segments 2-7
 * each opened a stint with none. This rewrites a segment, before
 * `normalizeInferredSelectors` and `resolveStintForSegment` see it, so that it
 * can reach what the earlier segments landed on:
 *
 * - `"segment:<n>"` (renumbered by `validateResult`) becomes segment n's stint
 *   in a stint slot, and that stint's quest in `matchedQuest`; the rest of the
 *   path then treats it like any listed id (open through the segment's end is
 *   reused, closed is continued).
 * - a quest id in a stint slot (#75's commonest mix-up) that an earlier segment
 *   of this window landed on becomes the stint that segment landed on (the
 *   latest one), unless `matchedQuest` names a different quest. Left to
 *   `normalizeInferredSelectors`, it would resolve against the window's lists
 *   only, which hold no stint this window opened, and open a second stint of
 *   the quest or continue an older one of another session.
 * - a `proposedQuest` whose title and outcome an earlier segment of this window
 *   already proposed becomes that quest in `matchedQuest`, not a second quest.
 * - a segment with `isSwitch: false` ("the outcome did not change versus the
 *   previous segment") that names no stint stays on the previous segment's stint,
 *   since a stint is one outcome. With the defaulted reason (the model named no
 *   selector at all) its quest has to agree: the same quest, no opinion, or a
 *   quest for a stint that has none and that this segment may attach one to.
 *   An explicit `newStintReason` is the model's own judgement and is overridden
 *   only when `matchedQuest` is the stint's own quest (the e854515d shape); the
 *   discarded reason is logged. A different quest is a different outcome,
 *   whatever `isSwitch` says, and opens its own stint as before.
 *
 * None of this reaches beyond the window: every id it hands on was resolved by
 * an earlier segment of the same window, so #75's guard against crossed and
 * garbled ids is untouched.
 */
function resolveWithinWindow(
  segment: ClassifierSegment,
  index: number,
  ledger: WindowLedger,
  attachable: AttachTargets,
): { segment: ClassifierSegment; reuses: string[]; repaired: boolean } {
  const reuses: string[] = [];
  let repaired = false;
  // `undefined` when the value is no reference at all. A reference past the
  // segments applied so far names nothing: `validateResult` never lets one
  // through, but a hand-built result could.
  const landedAt = (value: string | null | undefined) => {
    const position = parseSegmentReference(value);
    if (position === null) return undefined;
    reuses.push(`named segment ${position}`);
    return position >= 1 && position <= index ? (ledger.landed[position - 1] ?? null) : null;
  };
  const stintSlot = (value: string | null | undefined): string | null => {
    const landed = landedAt(value);
    return landed === undefined ? (value ?? null) : (landed?.stintId ?? null);
  };
  const questSlot = (value: string | null | undefined): string | null => {
    const landed = landedAt(value);
    return landed === undefined ? (value ?? null) : (landed?.questId ?? null);
  };

  let rewritten: ClassifierSegment = {
    ...segment,
    matchedStint: stintSlot(segment.matchedStint),
    continuesStint: stintSlot(segment.continuesStint),
    matchedQuest: questSlot(segment.matchedQuest),
  };

  // Only ids the model was offered can be a quest here (it never sees the id of
  // a quest this window creates), so a hit is one an earlier segment matched.
  const namedQuest = [rewritten.matchedStint, rewritten.continuesStint].find(
    (id): id is string =>
      id !== null && id !== undefined && ledger.landed.some((landed) => landed.questId === id),
  );
  if (
    namedQuest !== undefined &&
    (rewritten.matchedQuest === null || rewritten.matchedQuest === namedQuest)
  ) {
    let position = ledger.landed.length - 1;
    while (ledger.landed[position]?.questId !== namedQuest) position -= 1;
    rewritten = {
      ...rewritten,
      matchedStint: ledger.landed[position]?.stintId ?? null,
      continuesStint: null,
      matchedQuest: namedQuest,
      newStintReason: null,
      confidence: Math.min(rewritten.confidence, REPAIRED_CONFIDENCE_CAP),
    };
    reuses.push(`stint selector named quest ${namedQuest}, on segment ${position + 1}'s stint`);
    repaired = true;
  }

  if (
    rewritten.matchedStint === null &&
    rewritten.continuesStint === null &&
    (rewritten.newStintReason ?? null) === null
  ) {
    rewritten.newStintReason = DEFAULT_NEW_STINT_REASON;
  }

  const proposed = rewritten.proposedQuest ?? null;
  const proposedBefore =
    proposed === null ? undefined : ledger.proposedQuests.get(proposalKey(proposed));
  if (rewritten.matchedQuest === null && proposedBefore !== undefined) {
    rewritten = { ...rewritten, matchedQuest: proposedBefore, proposedQuest: null };
    reuses.push(`proposed quest ${proposedBefore} again`);
  }

  const previous = ledger.landed[index - 1];
  const reason = explicitReason(rewritten);
  if (
    previous !== undefined &&
    !rewritten.isSwitch &&
    rewritten.matchedStint === null &&
    rewritten.continuesStint === null &&
    (reason === null
      ? questAgrees(rewritten, previous, attachable)
      : previous.questId !== null && rewritten.matchedQuest === previous.questId)
  ) {
    rewritten = { ...rewritten, matchedStint: previous.stintId, newStintReason: null };
    reuses.push(
      reason === null
        ? `same outcome as segment ${index}`
        : `same outcome as segment ${index}, discarded newStintReason ${JSON.stringify(reason)}`,
    );
  }

  return { segment: reuses.length === 0 ? segment : rewritten, reuses, repaired };
}

/** Whether a segment may land on `stint` without disputing or taking its quest. */
function questAgrees(
  segment: ClassifierSegment,
  stint: { stintId: string; questId: string | null },
  attachable: AttachTargets,
): boolean {
  const matchedQuest = segment.matchedQuest ?? null;
  const proposed = segment.proposedQuest ?? null;
  if (matchedQuest === null && proposed === null) return true;
  if (stint.questId !== null) return matchedQuest === stint.questId;
  // The stint has no quest: landing on it attaches this one, which reaches every
  // earlier trace of the stint, so only where `reuseStint` would allow it.
  return (
    attachable.stintIds.has(stint.stintId) &&
    (matchedQuest === null || attachable.questIds.has(matchedQuest))
  );
}

function resolveStintForSegment(
  store: EventStore,
  database: Database,
  heroId: string,
  segment: ClassifierSegment,
  openedAt: string,
  attachable: AttachTargets,
): ResolvedStint {
  let unknownStintId = false;

  // `matchedStint` means "this stretch of attention is still going", so a stint
  // that is still open is reused. One that has since closed is a return after a
  // gap -- the model read the same stint from the "recent" list and used the
  // wrong selector for it -- so it becomes a `continues` link, exactly as if it
  // had named it in `continuesStint`. Opening an unlinked stint instead
  // fragmented one stretch of work into a stint per window. Only an id that
  // resolves to no live stint at all is unknown.
  let continues: string | null = null;
  if (typeof segment.matchedStint === "string") {
    const matched = readStint(database, segment.matchedStint, segment.endedAt);
    if (matched?.isOpen) {
      return reuseStint(
        store,
        database,
        heroId,
        segment,
        segment.matchedStint,
        matched.questId,
        attachable,
      );
    }
    if (matched !== null) {
      continues = segment.matchedStint;
    } else {
      unknownStintId = true;
    }
  }

  // `continuesStint` means "the same outcome, resumed after a gap", so it is
  // only a link when the stint it names has actually closed. Pointing it at a
  // still-open stint says the attention never stopped: that is a plain reuse,
  // and opening a second row would leave two open stints for one outcome.
  if (continues === null && typeof segment.continuesStint === "string") {
    const referenced = readStint(database, segment.continuesStint, segment.endedAt);
    if (referenced === null) {
      unknownStintId = true;
    } else if (referenced.isOpen) {
      return reuseStint(
        store,
        database,
        heroId,
        segment,
        segment.continuesStint,
        referenced.questId,
        attachable,
      );
    } else {
      continues = segment.continuesStint;
    }
  }

  let { questId, questCreated } = resolveQuest(store, database, heroId, segment);

  if (continues !== null && questId === null) {
    // Returning to a closed stint keeps its quest unless the classifier named another.
    questId = readStint(database, continues)?.questId ?? null;
  }

  const stintId = openStintContinuing(store, database, {
    quest: questId ?? undefined,
    outcome: segment.what,
    at: openedAt,
    actor: "hook",
    continues: continues ?? undefined,
  });

  return {
    stintId,
    questId,
    stintOpened: true,
    questCreated,
    questConflict: false,
    unknownStintId,
    questProposedOnMatched: false,
    questAttachedOnMatched: false,
  };
}

/**
 * Declared mode's stint resolution. Quest identity is now a per-segment decision
 * (`segment.quest`), since a session may have several quests active at once, but
 * the rule that nothing here creates, proposes, reassigns or branches a quest is
 * unchanged.
 *
 * `segment.stint` arrives as one of three prefixed shapes:
 *
 * - `P<n>.<m>` — a plan item of the segment's quest. A plan item is not a row
 *   until the first segment names it; `planStints` keeps the one stint per
 *   (quest, plan item) for the rest of the window, so a plan item named twice
 *   reuses its stint instead of opening a second. Across windows the same reuse
 *   comes from the open-stint lookup below.
 * - `S<n>` — a stint already open in the session, reused exactly as
 *   `matchedStint` did, including attaching a quest only when it has none.
 * - `new: <text>` — nothing listed fits; the text is the new stint's outcome.
 *
 * An alias the window never offered resolves to nothing and opens a new stint,
 * exactly as a fabricated id did before.
 */
/**
 * Trims, collapses internal whitespace, and lowercases an outcome for
 * `new:` reuse matching. A model that rephrases the same stint's outcome
 * with different capitalization or spacing across windows is plausible
 * variance, not a genuinely new outcome, so both sides of the comparison go
 * through this before being compared.
 */
function normalizeOutcome(outcome: string): string {
  return outcome.trim().replace(/\s+/g, " ").toLowerCase();
}

function resolveStintForSegmentDeclared(
  store: EventStore,
  database: Database,
  segment: ClassifierSegment,
  openedAt: string,
  questId: string | null,
  sessionId: string,
  openStintAliases: Record<string, string>,
  planAliases: Record<string, string>,
  planStints: Map<string, string>,
): ResolvedStint {
  const selector = segment.stint ?? "";

  const reuse = (stintId: string, existingQuestId: string | null): ResolvedStint => {
    // Reassignment is exactly what the verifier must never do, so the segment's
    // quest is attached only to a stint that has none.
    if (existingQuestId === null && questId !== null) {
      assignStint(store, database, stintId, questId, "hook");
    }
    return {
      stintId,
      questId: existingQuestId ?? questId,
      stintOpened: false,
      questCreated: false,
      questConflict: false,
      unknownStintId: false,
      questProposedOnMatched: false,
      questAttachedOnMatched: false,
    };
  };

  const open = (
    outcome: string,
    planIndex?: string,
    continues?: string,
    planItem?: string,
  ): ResolvedStint => {
    const stintId = openStintContinuing(store, database, {
      quest: questId ?? undefined,
      outcome,
      at: openedAt,
      actor: "hook",
      continues,
      planIndex,
      planItem,
    });
    return {
      stintId,
      questId,
      stintOpened: true,
      questCreated: false,
      questConflict: false,
      unknownStintId: false,
      questProposedOnMatched: false,
      questAttachedOnMatched: false,
    };
  };

  if (selector.startsWith("new: ")) {
    const outcome = selector.slice("new: ".length).trim();
    const normalizedOutcome = normalizeOutcome(outcome);

    // A `new:` selector whose text matches a stint already open or recently
    // closed in this session is the same outcome named twice, not a fresh one
    // -- without this, the same duplicate-screenshots outcome opened a new
    // stint every time the classifier phrased its `new:` the same way instead
    // of naming the stint's own `S<n>` alias. Matching is on normalized text
    // (trimmed, internal whitespace collapsed, case-insensitive) on both
    // sides, since a model that rephrases the same outcome with different
    // capitalization or spacing is plausible variance, not a new outcome.
    const openCandidates = database
      .query(
        `SELECT stints.id as id, stints.outcome as outcome, stints.quest_id as questId FROM stints
          WHERE stints.closed_at IS NULL
            AND stints.retracted_at IS NULL AND stints.dismissed_at IS NULL
            AND EXISTS (
              SELECT 1 FROM traces
               WHERE traces.stint_id = stints.id AND traces.retracted_at IS NULL
                 AND traces.session_id = ?)
          ORDER BY stints.opened_at DESC`,
      )
      .all(sessionId) as { id: string; outcome: string; questId: string | null }[];
    const openMatch = openCandidates.find(
      (candidate) => normalizeOutcome(candidate.outcome) === normalizedOutcome,
    );
    if (openMatch !== undefined) return reuse(openMatch.id, openMatch.questId);

    const closedCandidates = database
      .query(
        `SELECT stints.id as id, stints.outcome as outcome FROM stints
          WHERE stints.closed_at IS NOT NULL
            AND stints.retracted_at IS NULL AND stints.dismissed_at IS NULL
            AND EXISTS (
              SELECT 1 FROM traces
               WHERE traces.stint_id = stints.id AND traces.retracted_at IS NULL
                 AND traces.session_id = ?)
          ORDER BY stints.closed_at DESC`,
      )
      .all(sessionId) as { id: string; outcome: string }[];
    const closedMatch = closedCandidates.find(
      (candidate) => normalizeOutcome(candidate.outcome) === normalizedOutcome,
    );
    if (closedMatch !== undefined) return open(outcome, undefined, closedMatch.id);

    return open(outcome);
  }

  if (selector.startsWith("S")) {
    const stintId = openStintAliases[selector] ?? null;
    const referenced = stintId === null ? null : readStint(database, stintId);
    if (stintId !== null && referenced !== null) {
      // A closed stint named as `Sn` is a return after a gap, which is a new
      // stint linked to the old one -- reusing a closed row would reopen it.
      if (referenced.isOpen) return reuse(stintId, referenced.questId);
      return open(segment.what, undefined, stintId);
    }
    return { ...open(segment.what), unknownStintId: true };
  }

  if (selector.startsWith("P")) {
    const planItem = planAliases[selector];
    if (planItem === undefined) {
      return { ...open(segment.what), unknownStintId: true };
    }

    // One plan item is at most one stint per session, identified by
    // `(session, quest, plan line text)` alone. The alias is deliberately not
    // part of the key: `P<n>.<m>` is renumbered from scratch every window, so
    // inserting a line ahead of an unfinished item moves it from `P1.1` to
    // `P1.2` while naming the same outcome -- keying on the alias would open a
    // second stint for work already in flight and split its traces. The text
    // changing is the real amendment, and that correctly finds nothing here.
    const key = `${questId ?? "none"}:${planItem}`;
    const known = planStints.get(key);
    if (known !== undefined) {
      const referenced = readStint(database, known);
      if (referenced?.isOpen) return reuse(known, referenced.questId);
    }

    // `stints` has no session column -- a stint belongs to the session its
    // traces do, which is how `buildWindow` scopes its own candidate slice.
    const existing = database
      .query(
        `SELECT stints.id as id, stints.closed_at as closedAt FROM stints
          WHERE stints.plan_item = ? AND stints.retracted_at IS NULL
            AND stints.dismissed_at IS NULL
            AND (stints.quest_id IS ? OR stints.quest_id = ?)
            AND EXISTS (
              SELECT 1 FROM traces
               WHERE traces.stint_id = stints.id AND traces.retracted_at IS NULL
                 AND traces.session_id = ?)
          ORDER BY stints.opened_at DESC LIMIT 1`,
      )
      .get(planItem, questId, questId, sessionId) as { id: string; closedAt: string | null } | null;

    if (existing !== null && existing.closedAt === null) {
      planStints.set(key, existing.id);
      const referenced = readStint(database, existing.id);
      return reuse(existing.id, referenced?.questId ?? null);
    }

    // The same plan item had a stint that has since closed: coming back to it
    // is a return, so the new row links to the old one. An amended item finds
    // nothing here and simply opens its own stint, leaving the old one alone.
    const opened = open(planItem, selector, existing?.id, planItem);
    planStints.set(key, opened.stintId);
    return opened;
  }

  // Neither a known prefix nor a listed alias: validation repairs this shape
  // before apply sees it, so reaching here means a hand-built result.
  return open(segment.what);
}

/**
 * Why a doubt is recorded but never asked, or null when it may be. A guess of
 * `UNRECOGNIZED_QUEST_ALIAS_GUESS` is the validator's own, not a judgement the
 * model made; a doubt with no quoted trigger gives the human nothing to check.
 * A missing quest with several active (`QUEST_NOT_NAMED_GUESS`) is a real doubt
 * and asks when it has a trigger.
 */
function silentDoubtReason(segment: ClassifierSegment): "unrecognized alias" | "no trigger" | null {
  if (segment.guess === UNRECOGNIZED_QUEST_ALIAS_GUESS) return "unrecognized alias";
  if (typeof segment.trigger !== "string" || segment.trigger.trim() === "") return "no trigger";
  return null;
}

export function applyResult(
  store: EventStore,
  database: Database,
  window: ClassifierWindow,
  result: ClassifierResult,
  options: ApplyOptions,
): AppliedSummary {
  const heroId = requireHeroId(database);
  const declaredMode = (options.mode ?? "declared") === "declared";
  const summary: AppliedSummary = {
    traces: 0,
    stintsOpened: 0,
    questsProposed: 0,
    branches: 0,
    questionsWatching: 0,
    doubts: 0,
    doubtsSilent: 0,
    unknownStintIds: 0,
    selectorRepaired: 0,
    questProposedOnMatched: 0,
    questAttachedOnMatched: 0,
    sameWindowReuse: 0,
  };

  // Which quest a segment serves is now the model's per-segment call, resolved
  // through the window's alias maps: a session may hold several active at once,
  // so there is no single window-wide declared quest left to resolve.
  const questAliases: Record<string, string> = {
    ...(window.activeQuestAliases ?? {}),
    ...(window.parentActiveQuestAliases ?? {}),
  };
  // A subagent's doubt is addressed to whoever can answer it: the parent session.
  let questionSessionId = window.sessionId;
  if (declaredMode && window.parentActiveQuests.length > 0) {
    const at = window.messages.at(-1)?.ts ?? options.now;
    questionSessionId =
      latestDeclaredParentSessionId(database, window.sessionId, at) ?? window.sessionId;
  }

  // A doubted segment (`belongs: false`) stays on the quest it was judged against:
  // the one the model named, else the session's current one (the newest active
  // quest, the parent's for a subagent). The doubt is flagged on the trace and
  // asked about, but the work is never left without a quest because the model
  // was unsure; only a session with nothing active has no quest to keep.
  const currentQuestAlias = (
    window.activeQuests.length > 0 ? window.activeQuests : window.parentActiveQuests
  ).at(-1)?.alias;
  const segmentQuestId = (segment: ClassifierSegment): string | null => {
    if (segment.quest !== null && segment.quest !== undefined) {
      return questAliases[segment.quest] ?? null;
    }
    if (segment.belongs === false && currentQuestAlias !== undefined) {
      return questAliases[currentQuestAlias] ?? null;
    }
    return null;
  };

  // One stint per (quest, plan item) for the life of this window; across windows
  // the same reuse comes from the open-stint lookup in the resolver.
  const planStints = new Map<string, string>();

  // A declared session with nothing declared *yet* records its work with no quest
  // and asks to declare once for the whole window -- an undeclared window is one
  // gap, not N. A `declare` question is exactly as premature as a stint would be
  // for the same stretch, so it is only asked once the window's undeclared time
  // meets stintMinMinutes; the doubt has nothing to dismiss below that (no stint
  // or question was created), so there is no bookkeeping to suppress alongside it.
  const needsDeclaration = declaredMode && Object.keys(questAliases).length === 0;

  // Summed over the segments the loop below records. An overlap-tail segment
  // never gets here: `validateResult` drops one that lies wholly before the
  // window's first message, so the tail alone cannot trigger a `declare`
  // question for work that was never recorded this window.
  const undeclaredMinutes = needsDeclaration
    ? result.segments.reduce(
        (sum, segment) =>
          sum + (Date.parse(segment.endedAt) - Date.parse(segment.startedAt)) / 60_000,
        0,
      )
    : 0;
  const declarationDue = needsDeclaration && undeclaredMinutes >= options.stintMinMinutes;
  let declareAsked = false;

  const mostRecentOpen = window.sessionOpenStints.at(-1);
  let previous: { stintId: string; questId: string | null } | null = mostRecentOpen
    ? { stintId: mostRecentOpen.stintId, questId: mostRecentOpen.questId }
    : null;

  // The session may legitimately hold several stints open at once (a lead
  // coordinating two quests, a session running parallel subagents), so a
  // switch never closes anything -- it only marks the nexus event for
  // side-quest branching. A switch's quest counts as a branch only when it is
  // not already open in this session: returning to a quest already in flight
  // is not a nexus event, just attention moving back to something ongoing.
  const openSessionQuestIds = new Set(
    window.sessionOpenStints
      .map((stint) => stint.questId)
      .filter((questId): questId is string => questId !== null),
  );

  // The open quests and this session's open stints the window offered: the only
  // ones a matched stint with no quest may be attached to when the classifier
  // names one. The quests and stints this window opens join them as it goes:
  // they are this session's own, as much as the ones it was offered.
  const attachableQuestIds = new Set((window.openQuests ?? []).map((quest) => quest.id));
  const attachableStintIds = new Set(window.sessionOpenStints.map((stint) => stint.stintId));
  const attachable: AttachTargets = {
    questIds: attachableQuestIds,
    stintIds: attachableStintIds,
  };
  const ledger: WindowLedger = { landed: [], proposedQuests: new Map() };

  for (const [index, classified] of result.segments.entries()) {
    let segment = classified;
    if (!declaredMode) {
      const within = resolveWithinWindow(classified, index, ledger, attachable);
      if (within.reuses.length > 0) summary.sameWindowReuse += 1;
      for (const reuse of within.reuses) {
        options.log(
          `w5 stint resolved within window: session ${window.sessionId}, segment ${index + 1} ${reuse}`,
        );
      }
      const normalized = normalizeInferredSelectors(window, within.segment);
      if (within.repaired || normalized.repairs.length > 0) summary.selectorRepaired += 1;
      for (const repair of normalized.repairs) {
        options.log(`w5 stint selector repaired: session ${window.sessionId}, ${repair}`);
      }
      segment = normalized.segment;
    }
    // A stint opens when the work started, not when the classifier ran. For a
    // live run the two are minutes apart, but backfill classifies history with
    // `now` set to the run's own clock: stamping `opened_at` with it put every
    // stint days after the traces it owns, which is what made measured
    // durations negative and left `opened_at < windowEnd` unable to hold.
    const {
      stintId,
      questId,
      stintOpened,
      questCreated,
      questConflict,
      unknownStintId,
      questProposedOnMatched,
      questAttachedOnMatched,
    } = declaredMode
      ? resolveStintForSegmentDeclared(
          store,
          database,
          segment,
          segment.startedAt,
          segmentQuestId(segment),
          window.sessionId,
          window.openStintAliases ?? {},
          window.planAliases ?? {},
          planStints,
        )
      : resolveStintForSegment(store, database, heroId, segment, segment.startedAt, attachable);

    if (stintOpened) summary.stintsOpened += 1;
    if (questCreated) summary.questsProposed += 1;
    if (!declaredMode) {
      if (stintOpened) attachableStintIds.add(stintId);
      if (questCreated && questId !== null) {
        attachableQuestIds.add(questId);
        const proposed = segment.proposedQuest ?? null;
        if (proposed !== null) ledger.proposedQuests.set(proposalKey(proposed), questId);
      }
      // A quest attached now reaches every segment that landed on the stint.
      for (const landed of ledger.landed) {
        if (landed.stintId === stintId) landed.questId = questId;
      }
      ledger.landed.push({ stintId, questId });
    }
    if (unknownStintId) {
      summary.unknownStintIds += 1;
      options.log(
        `w5 unknown stint id: classifier named ${segment.stint ?? segment.matchedStint ?? segment.continuesStint ?? "none"}, which is not a candidate in the window; opened ${stintId} instead`,
      );
    }
    if (questProposedOnMatched) {
      summary.questProposedOnMatched += 1;
      options.log(
        `w5 quest proposed on matched stint: stint ${stintId} had no quest, attached newly proposed ${questId ?? "none"}`,
      );
    }
    if (questAttachedOnMatched) {
      summary.questAttachedOnMatched += 1;
      options.log(
        `w5 quest attached to matched stint: stint ${stintId} had no quest, attached ${questId ?? "none"}`,
      );
    }
    if (questConflict) {
      summary.doubts += 1;
      options.log(
        `w5 quest conflict: stint ${stintId} keeps quest ${questId ?? "none"}, classifier said ${segment.matchedQuest ?? "none"}`,
      );
    }

    if (
      !declaredMode &&
      segment.isSwitch &&
      questId !== null &&
      previous !== null &&
      questId !== previous.questId &&
      !openSessionQuestIds.has(questId)
    ) {
      branchQuest(store, database, {
        questId,
        fromStintId: previous.stintId,
        trigger: segment.trigger ?? "unknown",
        at: segment.startedAt,
      });
      summary.branches += 1;
    }

    if (questId !== null) openSessionQuestIds.add(questId);
    previous = { stintId, questId };

    const traceId = recordTrace(store, database, {
      stint: stintId,
      tool: "claude-code",
      place: `${window.org}/${window.project}`,
      source: "session",
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      who: "hero",
      what: segment.what,
      why: segment.why,
      where: `${window.org}/${window.project}`,
      how: "claude-code",
      confidence: segment.confidence,
      classifiedBy: "assistant",
      actor: options.actor,
      sessionId: window.sessionId,
      belongs: declaredMode ? segment.belongs : undefined,
      guess: declaredMode ? (segment.guess ?? null) : undefined,
      trigger: declaredMode && segment.belongs === false ? (segment.trigger ?? null) : undefined,
    });
    summary.traces += 1;

    if (declaredMode) {
      // A doubt is recorded even when asking is disabled (backfill), so the run
      // summary and `tempad review` still show it; only the hand-back is gated.
      if (segment.belongs === false) {
        summary.doubts += 1;
        // A doubt the model did not back with a quoted trigger, or one the
        // validator made up from an unrecognized quest alias, is recorded and
        // logged but never asked: the human would be answering a question nobody
        // could explain. The log line says which, and `doubtsSilent` counts them.
        const silentReason = silentDoubtReason(segment);
        if (silentReason !== null) summary.doubtsSilent += 1;
        options.log(
          `w5 doubt: session ${window.sessionId} stint ${stintId} guess "${segment.guess ?? ""}"${
            silentReason === null ? "" : ` (no question: ${silentReason})`
          }`,
        );
        if (options.askingEnabled && silentReason === null) {
          askQuestion(store, database, {
            trace: traceId,
            sessionId: questionSessionId,
            kind: "belongs",
            // Internal only: the sentence the human sees is rendered fresh in
            // `w5/hooks.ts` from kind + guess + the declared title.
            text: "belongs",
            guess: segment.guess,
            isSwitch: segment.isSwitch,
            actor: options.actor,
          });
          summary.questionsWatching += 1;
        }
      }

      if (declarationDue && !declareAsked && options.askingEnabled) {
        askQuestion(store, database, {
          trace: traceId,
          sessionId: questionSessionId,
          kind: "declare",
          text: "declare",
          isSwitch: false,
          actor: options.actor,
        });
        summary.questionsWatching += 1;
        declareAsked = true;
      }
      continue;
    }

    if (segment.questions !== undefined && segment.questions.length > 0 && options.askingEnabled) {
      for (const kind of segment.questions) {
        askQuestion(store, database, {
          trace: traceId,
          sessionId: window.sessionId,
          kind,
          text: kind,
          isSwitch: segment.isSwitch,
          actor: options.actor,
        });
        summary.questionsWatching += 1;
      }
    }
  }

  return summary;
}
