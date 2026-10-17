import { classifyWithRetry } from "./classifier-shared";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";

export interface ClassifierWindow {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  org: string;
  project: string;
  messages: { ts: string; role: string; text: string }[];
  /**
   * Which prompt and apply path this window is for. `"inferred"` is the
   * pre-verifier behavior, used by `[w5].mode = "inferred"` and by backfill's
   * per-session fallback for a session that never declares anything; it is what
   * decides which schema the model is asked to fill in, so it must travel with
   * the window rather than being guessed from which optional fields are set.
   */
  mode: "declared" | "inferred";
  /**
   * Every quest this session has declared and not ended (`tempad quest declare`),
   * as of the window's reference time, each with the alias the model names it by.
   * Empty means the session has not declared anything yet, which the verifier
   * reads as "ask to declare" rather than "infer one".
   */
  activeQuests: (DeclaredQuestSlice & { alias: string })[];
  /** alias -> real quest id, e.g. `{ Q1: "01H..." }`. */
  activeQuestAliases: Record<string, string>;
  /**
   * Set only for a subagent session, from the parent's own active quests, aliased
   * `PQ1..PQn`. A subagent may place a segment on one of the parent's quests
   * directly, so the two alias spaces are offered together and never collide.
   */
  parentActiveQuests: (DeclaredQuestSlice & { alias: string })[];
  /** alias -> real quest id for the parent's quests, e.g. `{ PQ1: "01H..." }`. */
  parentActiveQuestAliases: Record<string, string>;
  /**
   * alias -> real stint id, e.g. `{ S1: "01H..." }`. The model only ever sees
   * the alias, so there is no 26-character id for it to garble, and `apply.ts`
   * maps whatever it returns back through this map.
   */
  openStintAliases: Record<string, string>;
  /**
   * alias -> plan text, e.g. `{ "P2.1": "Refactor the window builder" }`, one
   * entry per plan item of each active quest. A plan item becomes a real stint
   * only once a segment names it, so these are prompt-only until `apply.ts`
   * opens one.
   */
  planAliases?: Record<string, string>;
  /**
   * Inference-mode only (`[w5].mode = "inferred"`, or the backfill fallback for a
   * session that never declares anything). Absent in declared mode.
   */
  openQuests?: {
    id: string;
    title: string;
    outcome: string | null;
    lastStintAt: string | null;
  }[];
  sessionOpenStints: {
    stintId: string;
    what: string;
    why: string;
    questId: string | null;
    questTitle: string | null;
    openedAt: string;
    lastTraceEndedAt: string;
  }[];
  recentStints: {
    stintId: string;
    what: string;
    why: string;
    questId: string | null;
    questTitle: string | null;
    openedAt: string;
    lastTraceEndedAt: string;
    closedAt: string | null;
    closeReason: string | null;
  }[];
  /** Inference-mode only, like `openQuests`. */
  recentSideQuests?: { id: string; title: string; trigger: string }[];
  overlapMessages: { ts: string; role: string; text: string }[];
  previousSessionNote: string | null;
}

export interface DeclaredQuestSlice {
  title: string;
  outcome: string | null;
  plan: string[];
}

/**
 * The plan-alias prefix for a quest alias: `Q2` numbers its plan `P2.1`, `P2.2`,
 * and a parent's `PQ2` numbers its own `PP2.1` — swapping the trailing `Q` for a
 * `P` keeps the two spaces distinct, which a bare number would not (`PQ1` and
 * `Q1` would both yield `P1`).
 */
export function planAliasPrefix(questAlias: string): string {
  return questAlias.replace(/Q(\d+)$/, "P$1");
}

export type QuestionKind = "belongs" | "declare";

/** Retained for the inference fallback; declared mode proposes no quests. */
export type Commitment = "promised" | "personal" | "exploratory";

/** The question kinds the pre-verifier classifier was allowed to raise. */
export type LegacyQuestionKind = "which_quest" | "why" | "trigger";

export interface ClassifierSegment {
  startedAt: string;
  endedAt: string;
  what: string;
  why: string;
  /**
   * Does this segment belong to the declared quest (the parent's, for a
   * subagent)? Declared mode requires it -- `validateSegment` rejects a segment
   * without it -- and inference mode is never asked for it, hence optional here.
   */
  belongs?: boolean;
  /**
   * Short string naming what it looks like instead; required when `belongs` is
   * false, forced to null when it is true. Declared mode only.
   */
  guess?: string | null;
  /**
   * Declared mode: the alias (`"Q1"`, or a parent's `"PQ1"`) of the active quest
   * this segment serves. `null` only when `belongs` is false -- a segment that
   * serves nothing declared has no quest to name.
   */
  quest?: string | null;
  /**
   * Declared mode: which stint the segment lands on, as one of `"P<n>.<m>"` (a
   * plan item of its quest), `"S<n>"` (a stint already open in the session), or
   * `"new: <one line>"` (nothing listed fits). One field with a structural
   * prefix rather than three optionals, because the candidates now come from two
   * different sources that the value itself has to disambiguate.
   */
  stint?: string;
  /** Inference mode only. Alias in declared mode is gone; see `stint`. */
  matchedStint?: string | null;
  /** Inference mode only. */
  continuesStint?: string | null;
  /** Inference mode only. */
  newStintReason?: string | null;
  isSwitch: boolean;
  trigger: string | null;
  confidence: number;
  /**
   * Inference-mode only. The verifier makes no quest decision, so these are
   * absent in declared mode and only read on the fallback path.
   */
  matchedQuest?: string | null;
  proposedQuest?: { title: string; outcome: string; commitment: Commitment } | null;
  questions?: LegacyQuestionKind[];
}

export interface ClassifierResult {
  segments: ClassifierSegment[];
  sessionNote: string | null;
  /**
   * Segments that named none of the three stint selectors and were given a
   * default `newStintReason` instead of being rejected. Optional because a
   * result built by hand (tests, a stub classifier) repaired nothing; only
   * `validateResult` ever sets it.
   */
  selectorDefaulted?: number;
  /**
   * Segments the model placed wholly before the window's first message, i.e. in
   * the context-only overlap tail, and that validation dropped: that stretch was
   * already classified by an earlier run, so recording it would double-count.
   */
  overlapDropped?: number;
  /** Segments that partly overlapped the window and had a bound clamped to it. */
  boundsClamped?: number;
  /** Segments with `belongs: false` that named no guess and got `UNSPECIFIED_GUESS`. */
  guessDefaulted?: number;
  /** 1 when the `sessionNote` was over the limit and cut, else 0. */
  sessionNoteTruncated?: number;
  /**
   * Segments that named more than one selector and were narrowed to the first by
   * precedence (matchedStint > continuesStint > newStintReason).
   */
  selectorAmbiguous?: number;
}

export const MAX_SESSION_NOTE_LENGTH = 300;

/**
 * Stands in for the `guess` of a `belongs: false` segment that named none. The
 * doubt itself is real, only its description is missing; this is the same text
 * the hand-back falls back to for a question stored with no guess, so the human
 * reads one wording either way.
 */
export const UNSPECIFIED_GUESS = "something else";

/** Stands in for a `newStintReason` the classifier omitted entirely. */
export const DEFAULT_NEW_STINT_REASON = "classifier gave no reason";

/**
 * The guess put on a segment whose `quest` alias the window never offered. The
 * model was clearly trying to place the work somewhere, so the segment surfaces
 * as a doubt rather than silently attaching to nothing.
 */
export const UNRECOGNIZED_QUEST_ALIAS_GUESS = "unrecognized quest alias";

/**
 * The guess repaired onto a `belongs: true` segment with a missing or null
 * `quest` when two or more quests are active -- there is no single quest left
 * to default to, so this is a doubt like any other unrecognized alias, never a
 * validation failure.
 */
export const QUEST_NOT_NAMED_GUESS = "quest not named";

/**
 * Optional fields a model routinely omits rather than sending as `null`. JSON has
 * no way to distinguish "absent" from "null" here and the two mean the same thing
 * to us, so absent is normalized to `null` before anything is validated -- a
 * missing key used to be reported as "expected string or null" and fail the whole
 * window.
 */
const NULLABLE_SEGMENT_FIELDS = ["guess", "matchedQuest", "proposedQuest", "trigger"] as const;

/** Inference mode's three-way selector fields, absent by design in declared mode. */
const NULLABLE_INFERRED_SELECTOR_FIELDS = [
  "matchedStint",
  "continuesStint",
  "newStintReason",
] as const;

export const QUESTION_KINDS = new Set<QuestionKind>(["belongs", "declare"]);
const LEGACY_QUESTION_KINDS = new Set<LegacyQuestionKind>(["which_quest", "why", "trigger"]);
const COMMITMENTS = new Set<Commitment>(["promised", "personal", "exploratory"]);

function requireString(value: unknown, path: string, problems: string[]): value is string {
  if (typeof value !== "string") {
    problems.push(`${path}: expected string, got ${typeof value}`);
    return false;
  }
  return true;
}

interface SelectorCounters {
  selectorDefaulted: number;
  selectorAmbiguous: number;
  guessDefaulted: number;
}

interface RepairCounters {
  overlapDropped: number;
  boundsClamped: number;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function instantOf(value: string): number {
  return ISO_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
}

/**
 * Cuts `text` to at most `length` UTF-16 units without leaving half of a
 * surrogate pair at the end.
 */
export function cutAtCodePoint(text: string, length: number): string {
  let cut = length;
  const last = text.charCodeAt(cut - 1);
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/**
 * Brings a segment's timestamps inside the window, or says to drop it.
 *
 * The prompt lists an overlap tail as context only, but models classify it
 * anyway, and a segment that starts in the tail and runs into the window is
 * ordinary. A segment ending at or before the window's first message lies
 * wholly in that tail (it is earlier work an earlier run already recorded) and
 * is dropped. One that straddles the first message starts there instead, and
 * one that runs a moment past the last message ends there; both are counted as
 * clamped, and a clamp that leaves no time (`start >= end`) drops the segment
 * too, since a zero-minute trace would only open a stint or re-ask a question
 * about work already recorded. Instants are compared, not strings, and a kept
 * pair is normalized to canonical UTC text.
 *
 * Anything that is not a well-formed pair is left alone for `validateSegment`
 * to report with its retry hint: not an ISO timestamp, an end before its start,
 * or a start after the last message. Dropping those would turn a mistake the
 * model can fix into silent loss.
 */
function repairBounds(
  raw: unknown,
  bounds: { firstTs: string; lastTs: string },
  counters: RepairCounters,
): "keep" | "drop" {
  if (typeof raw !== "object" || raw === null) return "keep";
  const segment = raw as Record<string, unknown>;
  const { startedAt, endedAt } = segment;
  if (typeof startedAt !== "string" || typeof endedAt !== "string") return "keep";

  const first = instantOf(bounds.firstTs);
  const last = instantOf(bounds.lastTs);
  const start = instantOf(startedAt);
  const end = instantOf(endedAt);
  if (Number.isNaN(first) || Number.isNaN(last) || Number.isNaN(start) || Number.isNaN(end)) {
    return "keep";
  }
  if (start > end) return "keep";

  // A well-formed pair is rewritten to canonical UTC (`toISOString`) so that
  // `validateSegment` and everything after it, which compare and store text,
  // see the instant the model meant: `12:05-03:00` is `15:05:00.000Z`, and
  // `15:30:00Z` equals a message at `15:30:00.000Z` instead of sorting after it.
  segment.startedAt = new Date(start).toISOString();
  segment.endedAt = new Date(end).toISOString();

  if (start < first && end <= first) {
    counters.overlapDropped += 1;
    return "drop";
  }
  if (start > last) return "keep";

  const clampStart = start < first;
  const clampEnd = end > last;
  if (!clampStart && !clampEnd) return "keep";
  if ((clampStart ? first : start) >= (clampEnd ? last : end)) {
    counters.overlapDropped += 1;
    return "drop";
  }
  if (clampStart) segment.startedAt = bounds.firstTs;
  if (clampEnd) segment.endedAt = bounds.lastTs;
  counters.boundsClamped += 1;
  return "keep";
}

interface DeclaredAliases {
  quests: Set<string>;
  openStints: Set<string>;
  plans: Set<string>;
  /**
   * The one active quest's alias, set only when the session (plus parent) has
   * exactly one. A `belongs: true` segment with a missing, null or
   * unrecognized `quest` then has an unambiguous default to silently assign
   * instead of surfacing as a doubt.
   */
  soleQuest: string | null;
}

/**
 * Whether a declared-mode `stint` value names something the window actually
 * offered. `P` and `S` must resolve against the window's own maps; `new:` needs
 * a non-empty outcome after the prefix, since the text becomes the stint's
 * outcome verbatim.
 */
function isKnownStintSelector(selector: string, aliases: DeclaredAliases): boolean {
  if (selector.startsWith("new: ")) return selector.slice("new: ".length).trim() !== "";
  if (selector.startsWith("P")) return aliases.plans.has(selector);
  if (selector.startsWith("S")) return aliases.openStints.has(selector);
  return false;
}

function validateSegment(
  raw: unknown,
  index: number,
  problems: string[],
  bounds: { firstTs: string; lastTs: string } | null,
  counters: SelectorCounters,
  aliases: Set<string> | null,
  mode: "declared" | "inferred",
  declaredAliases: DeclaredAliases | null,
): void {
  const where = `segments[${index}]`;
  if (typeof raw !== "object" || raw === null) {
    problems.push(`${where}: expected an object`);
    return;
  }
  const segment = raw as Record<string, unknown>;

  for (const field of NULLABLE_SEGMENT_FIELDS) {
    if (segment[field] === undefined) segment[field] = null;
  }
  if (mode === "inferred") {
    for (const field of NULLABLE_INFERRED_SELECTOR_FIELDS) {
      if (segment[field] === undefined) segment[field] = null;
    }
  }

  const startedAtIsString = requireString(segment.startedAt, `${where}.startedAt`, problems);
  const endedAtIsString = requireString(segment.endedAt, `${where}.endedAt`, problems);
  requireString(segment.what, `${where}.what`, problems);
  requireString(segment.why, `${where}.why`, problems);

  if (bounds !== null) {
    if (startedAtIsString) {
      const startedAt = segment.startedAt as string;
      if (startedAt < bounds.firstTs || startedAt > bounds.lastTs) {
        problems.push(
          `${where}.startedAt: ${startedAt} is outside the window [${bounds.firstTs}, ${bounds.lastTs}]`,
        );
      }
    }
    if (endedAtIsString) {
      const endedAt = segment.endedAt as string;
      if (endedAt < bounds.firstTs || endedAt > bounds.lastTs) {
        problems.push(
          `${where}.endedAt: ${endedAt} is outside the window [${bounds.firstTs}, ${bounds.lastTs}]`,
        );
      }
    }
  }

  // `belongs`/`guess` are the verifier's fields; an inference-mode window is never
  // asked for them, so requiring them there would reject every window that path
  // produces.
  if (mode === "inferred") {
    if (segment.belongs !== undefined && typeof segment.belongs !== "boolean") {
      problems.push(`${where}.belongs: expected boolean`);
    }
  } else if (typeof segment.belongs !== "boolean") {
    problems.push(`${where}.belongs: expected boolean`);
  } else {
    // A `quest` that names nothing the window offered: missing, null, or an
    // alias the window never listed. With exactly one active quest there is an
    // unambiguous default to assign silently; with several it is a doubt like
    // any other unrecognized alias; with none there is nothing to belong to,
    // so the model's `quest` is dropped. Never a validation failure.
    let nothingToBelongTo = false;
    if (segment.belongs === true && declaredAliases !== null) {
      const questIsUnrecognized =
        typeof segment.quest === "string" && !declaredAliases.quests.has(segment.quest);
      const questIsMissing = segment.quest === null || segment.quest === undefined;

      if ((questIsMissing || questIsUnrecognized) && declaredAliases.soleQuest !== null) {
        segment.quest = declaredAliases.soleQuest;
      } else if ((questIsMissing || questIsUnrecognized) && declaredAliases.quests.size === 0) {
        // The session has declared nothing (yet, or any more): the prompt says
        // "active quests: none (ask to declare)", and a model that still answers
        // `belongs: true` has no alias it could have meant. It is not a doubt
        // about a quest: `applyResult` already records such a window's traces with no
        // quest and asks to `declare` once for the whole window, so a per-segment
        // doubt here would turn one gap into N questions. The quest is dropped,
        // and counted like every other selector the model got wrong.
        segment.quest = null;
        nothingToBelongTo = true;
        counters.selectorDefaulted += 1;
      } else if (questIsUnrecognized) {
        segment.belongs = false;
        segment.quest = null;
        if (typeof segment.guess !== "string" || segment.guess.trim() === "") {
          segment.guess = UNRECOGNIZED_QUEST_ALIAS_GUESS;
        }
        counters.selectorDefaulted += 1;
      } else if (questIsMissing) {
        // Two or more active quests and no single one to default to, but failing
        // the whole window over a missing selector loses a real stretch of work:
        // repaired exactly like an unrecognized alias, same counter, same doubt.
        segment.belongs = false;
        segment.quest = null;
        segment.guess = QUEST_NOT_NAMED_GUESS;
        counters.selectorDefaulted += 1;
      }
    }

    if (segment.belongs === false) {
      // A doubt with nothing to say is useless to the human answering it, but
      // the doubt is real: only its description is missing, and failing the
      // window would lose the stretch of work it describes.
      if (typeof segment.guess !== "string" || segment.guess.trim() === "") {
        segment.guess = UNSPECIFIED_GUESS;
        counters.guessDefaulted += 1;
      }
      // A segment that serves nothing declared has no quest to name.
      segment.quest = null;
    } else {
      if (segment.guess !== null) {
        // Repair, don't reject: a segment that belongs has no need to guess what
        // else it might be, and a model that fills it in anyway is just noisy.
        segment.guess = null;
      }
      if (typeof segment.quest !== "string" && !nothingToBelongTo) {
        problems.push(`${where}.quest: expected an active quest alias when belongs is true`);
      }
    }
  }

  if (
    segment.matchedQuest !== undefined &&
    segment.matchedQuest !== null &&
    typeof segment.matchedQuest !== "string"
  ) {
    problems.push(`${where}.matchedQuest: expected string or null`);
  }
  if (mode === "declared") {
    // One field with a structural prefix, so there is no "exactly one of three"
    // rule left to reconcile: the value either parses against a listed candidate
    // or is repaired into a new stint named by the segment itself.
    if (typeof segment.stint !== "string") {
      problems.push(`${where}.stint: expected string`);
    } else if (declaredAliases !== null && !isKnownStintSelector(segment.stint, declaredAliases)) {
      segment.stint = `new: ${typeof segment.what === "string" ? segment.what : ""}`;
      counters.selectorDefaulted += 1;
    }
  } else {
    if (segment.matchedStint !== null && typeof segment.matchedStint !== "string") {
      problems.push(`${where}.matchedStint: expected string or null`);
    }
    if (segment.continuesStint !== null && typeof segment.continuesStint !== "string") {
      problems.push(`${where}.continuesStint: expected string or null`);
    }
    if (segment.newStintReason !== null && typeof segment.newStintReason !== "string") {
      problems.push(`${where}.newStintReason: expected string or null`);
    }

    // An alias the window never offered resolves to nothing, exactly as a
    // fabricated ULID did before the alias scheme: it is dropped here so the
    // existing selector repair below re-defaults the segment, rather than adding
    // a third counter for the same failure.
    if (aliases !== null) {
      if (typeof segment.matchedStint === "string" && !aliases.has(segment.matchedStint)) {
        segment.matchedStint = null;
      }
      if (typeof segment.continuesStint === "string" && !aliases.has(segment.continuesStint)) {
        segment.continuesStint = null;
      }
    }

    // The prompt still asks for exactly one selector, but a model that sets none
    // or several is repaired rather than rejected: failing the window loses a
    // real stretch of work over a formatting slip, and both repairs are counted
    // so the run summary shows how often the model is missing the rule.
    const selectors = [segment.matchedStint, segment.continuesStint, segment.newStintReason].filter(
      (candidate) => candidate !== null,
    );
    if (selectors.length === 0) {
      segment.newStintReason = DEFAULT_NEW_STINT_REASON;
      counters.selectorDefaulted += 1;
    } else if (selectors.length > 1) {
      if (segment.matchedStint !== null) {
        segment.continuesStint = null;
        segment.newStintReason = null;
      } else {
        segment.newStintReason = null;
      }
      counters.selectorAmbiguous += 1;
    }
  }
  if (segment.trigger !== null && typeof segment.trigger !== "string") {
    problems.push(`${where}.trigger: expected string or null`);
  }
  if (typeof segment.isSwitch !== "boolean") {
    problems.push(`${where}.isSwitch: expected boolean`);
  }

  if (segment.proposedQuest !== undefined && segment.proposedQuest !== null) {
    if (typeof segment.proposedQuest !== "object") {
      problems.push(`${where}.proposedQuest: expected object or null`);
    } else {
      const proposed = segment.proposedQuest as Record<string, unknown>;
      requireString(proposed.title, `${where}.proposedQuest.title`, problems);
      requireString(proposed.outcome, `${where}.proposedQuest.outcome`, problems);
      if (!COMMITMENTS.has(proposed.commitment as Commitment)) {
        problems.push(`${where}.proposedQuest.commitment: expected promised|personal|exploratory`);
      }
    }
  }

  if (typeof segment.confidence !== "number" || segment.confidence < 0 || segment.confidence > 1) {
    problems.push(`${where}.confidence: expected number between 0 and 1`);
  }

  // Inference-mode only: the verifier raises no per-segment questions.
  if (segment.questions !== undefined) {
    if (!Array.isArray(segment.questions)) {
      problems.push(`${where}.questions: expected array`);
    } else {
      for (const [questionIndex, question] of segment.questions.entries()) {
        if (!LEGACY_QUESTION_KINDS.has(question as LegacyQuestionKind)) {
          problems.push(
            `${where}.questions[${questionIndex}]: unknown question kind ${String(question)}`,
          );
        }
      }
    }
  }
}

export function validateResult(raw: unknown, window?: ClassifierWindow): ClassifierResult {
  const problems: string[] = [];
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as { segments?: unknown }).segments)
  ) {
    throw new Error("classifier result: expected { segments: [...] }");
  }

  const bounds =
    window !== undefined && window.messages.length > 0
      ? {
          firstTs: window.messages[0]?.ts as string,
          lastTs: window.messages.at(-1)?.ts as string,
        }
      : null;

  const mode = window?.mode ?? "declared";
  // Inference mode carries real ids in its slice, not aliases, so there is no
  // closed set to validate a selector against.
  const aliases =
    mode === "declared" && window !== undefined && window.openStintAliases !== undefined
      ? new Set(Object.keys(window.openStintAliases))
      : null;

  // A hand-built window in a test may offer no maps at all; without them there
  // is no closed set to check a selector against, so validation leaves the
  // model's values alone rather than repairing everything into a new stint.
  const declaredAliases: DeclaredAliases | null =
    mode === "declared" && window !== undefined
      ? (() => {
          const questAliasList = [
            ...Object.keys(window.activeQuestAliases ?? {}),
            ...Object.keys(window.parentActiveQuestAliases ?? {}),
          ];
          return {
            quests: new Set(questAliasList),
            openStints: new Set(Object.keys(window.openStintAliases ?? {})),
            plans: new Set(Object.keys(window.planAliases ?? {})),
            soleQuest: questAliasList.length === 1 ? (questAliasList[0] ?? null) : null,
          };
        })()
      : null;

  const counters: SelectorCounters = {
    selectorDefaulted: 0,
    selectorAmbiguous: 0,
    guessDefaulted: 0,
  };
  const repairs: RepairCounters = { overlapDropped: 0, boundsClamped: 0 };
  const segments =
    bounds === null
      ? (raw as { segments: unknown[] }).segments
      : (raw as { segments: unknown[] }).segments.filter(
          (segment) => repairBounds(segment, bounds, repairs) === "keep",
        );
  for (const [index, segment] of segments.entries()) {
    validateSegment(segment, index, problems, bounds, counters, aliases, mode, declaredAliases);
  }

  let sessionNote = (raw as { sessionNote?: unknown }).sessionNote;
  let sessionNoteTruncated = 0;
  if (typeof sessionNote === "string" && sessionNote.length > MAX_SESSION_NOTE_LENGTH) {
    // A hint for the next run, not a fact: cutting it loses a few words, failing
    // the window would lose the work classified alongside it.
    sessionNote = `${cutAtCodePoint(sessionNote, MAX_SESSION_NOTE_LENGTH - 1)}…`;
    sessionNoteTruncated = 1;
  }
  if (sessionNote !== undefined && sessionNote !== null && typeof sessionNote !== "string") {
    problems.push(
      `sessionNote: expected null or a string of at most ${MAX_SESSION_NOTE_LENGTH} characters`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`classifier result invalid:\n${problems.join("\n")}`);
  }
  return {
    segments: segments as ClassifierSegment[],
    sessionNote: (sessionNote as string | null | undefined) ?? null,
    selectorDefaulted: counters.selectorDefaulted,
    selectorAmbiguous: counters.selectorAmbiguous,
    guessDefaulted: counters.guessDefaulted,
    overlapDropped: repairs.overlapDropped,
    boundsClamped: repairs.boundsClamped,
    sessionNoteTruncated,
  };
}

export interface Classifier {
  classify(window: ClassifierWindow): Promise<ClassifierResult>;
}

export interface AnthropicClassifierOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

export class AnthropicClassifier implements Classifier {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AnthropicClassifierOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    // The window's mode decides which schema the model is asked to fill in.
    const systemPrompt = buildSystemPrompt(window.mode);
    const userPrompt = buildUserPrompt(window);
    return classifyWithRetry(window, userPrompt, (prompt) => this.request(systemPrompt, prompt));
  }

  private async request(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(
        `anthropic request failed: status ${response.status} ${bodyText.slice(0, 200)}`,
      );
    }

    const body = (await response.json()) as { content: { type: string; text?: string }[] };
    const textBlock = body.content.find(
      (block) => block.type === "text" && typeof block.text === "string",
    );
    if (!textBlock?.text) throw new Error("anthropic response contained no text block");
    return textBlock.text;
  }
}
