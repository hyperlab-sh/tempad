import type { Database } from "bun:sqlite";

/**
 * Title-quality judgement for `quest declare --new`, per bead tempad-7b2.
 *
 * The verifier matches work against quest titles, so a vague title ("fix
 * stuff", "S1") or a near-duplicate of an existing open quest produces doubts
 * and duplicate quests. This module is the one detector: a pure function over
 * the proposed title and the existing quest titles, no model call, no I/O --
 * the caller hands it the slice of quests to compare against, so the declare
 * path, the projection reducer and the tests all see the same verdict.
 *
 * The verdict is derivable from events (a quest's title at creation plus every
 * later `quest.reworded`), so it lives in a projection column
 * (`quests.title_vague`), never in an event of its own.
 */

export type TitleVerdictKind = "ok" | "vague" | "duplicate";

export interface TitleVerdict {
  verdict: TitleVerdictKind;
  /** Why, in one short phrase; `duplicate:<quest id>` for a duplicate. */
  reason: string;
  /** The existing quest a duplicate points at. */
  duplicateOf?: string;
}

/** Words a title made only of (plus stop words) says nothing specific about. */
const GENERIC_WORDS = [
  "fix",
  "fixes",
  "fixing",
  "bug",
  "bugs",
  "ship",
  "release",
  "stuff",
  "things",
  "work",
  "misc",
  "cleanup",
  "update",
  "updates",
  "changes",
  "wip",
  "todo",
  "test",
  "tests",
  "coordination",
  "follow-up",
  "followups",
  "leftovers",
];

/** Words ignored both when matching a duplicate and when judging vagueness. */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "for",
  "of",
  "and",
  "to",
  "in",
  "on",
  "with",
  "up",
  "it",
]);

/** The words the duplicate comparison strips, exactly the brief's list. */
const DUPLICATE_STRIP_WORDS = new Set(["the", "a", "an", "for", "of"]);

/** Generic words as the tokenizer sees them ("follow-up" -> "follow", "up"). */
const GENERIC_TOKENS = new Set(GENERIC_WORDS.flatMap((word) => tokenize(word)));

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Case-, whitespace- and punctuation-insensitive title with the words
 * "the/a/an/for/of" dropped: two titles that normalize to the same string are
 * the same title ("Fix the sync token" == "fix sync, token").
 */
function normalizeForDuplicate(title: string): string {
  return tokenize(title)
    .filter((token) => !DUPLICATE_STRIP_WORDS.has(token))
    .join(" ");
}

/**
 * A technical identifier in the title as written: an uppercase acronym
 * (`JWT`, `SSH`, `TTL`) or a letter-digit mix (`S3`, `marko2`). These make a
 * short title concrete ("Fix JWT TTL") even though every token is 3 letters
 * or less, so shortness alone must not flag them.
 */
function isTechnicalIdentifier(raw: string): boolean {
  return /^[A-Z]{2,}[0-9]*$/.test(raw) || /^[A-Za-z]+[0-9]+[A-Za-z0-9]*$/.test(raw);
}

/** Raw whitespace-separated words of the title as written (case kept). */
function rawWords(title: string): string[] {
  return title
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * Judge a proposed quest title against the existing quests the caller chose to
 * compare with (the declare path and the projection pass the open quests).
 *
 * Rules, in order:
 *
 * (a) duplicate -- a case-, whitespace- and punctuation-insensitive match of
 *     one of the existing titles, or equality after additionally stripping the
 *     words "the/a/an/for/of". The existing quest's id is suggested, never
 *     enforced: the caller creates the quest anyway.
 * (b) vague -- the title matches a code (`S1`, `42`), or is made only of
 *     generic words ("fix stuff and things") and stop words, or is short
 *     without anything concrete in it. Shortness is a supporting signal,
 *     never a verdict on its own: a short title that names a specific object
 *     ("Fix deadlocks", "Rotate credentials") or carries a technical
 *     identifier ("Fix JWT TTL", "Add SSH key") is ok. Concretely, the third
 *     rule fires only when the title has at most 3 words, none longer than 3
 *     letters, and none is a technical identifier (an uppercase acronym like
 *     `JWT`/`SSH` or a letter-digit mix like `S3`).
 * (c) otherwise ok.
 */
export function judgeTitleQuality(
  proposed: string,
  existing: Iterable<{ id: string; title: string }>,
): TitleVerdict {
  const trimmed = proposed.trim();
  if (trimmed.length === 0) return { verdict: "vague", reason: "empty title" };

  // (a) duplicate, checked first: naming an existing quest exactly is the most
  // actionable finding, and its suggestion is what the flag records.
  const proposedKey = normalizeForDuplicate(trimmed);
  if (proposedKey.length > 0) {
    for (const quest of existing) {
      if (normalizeForDuplicate(quest.title) === proposedKey) {
        return {
          verdict: "duplicate",
          reason: `duplicate:${quest.id}`,
          duplicateOf: quest.id,
        };
      }
    }
  }

  // (b) vague.
  if (/^[A-Za-z]?\d+$/.test(trimmed)) {
    return { verdict: "vague", reason: "looks like a code" };
  }
  const tokens = tokenize(trimmed);
  const contentTokens = tokens.filter((token) => !STOP_WORDS.has(token));
  if (contentTokens.length > 0 && contentTokens.every((token) => GENERIC_TOKENS.has(token))) {
    return { verdict: "vague", reason: "only generic words" };
  }
  const longest = tokens.reduce((max, token) => Math.max(max, token.length), 0);
  const hasTechnical = rawWords(trimmed).some((word) => isTechnicalIdentifier(word));
  if (tokens.length <= 3 && longest <= 3 && !hasTechnical) {
    return { verdict: "vague", reason: "short title with nothing specific in it" };
  }

  return { verdict: "ok", reason: "" };
}

/**
 * The quests a new declaration could duplicate: open (not ended, not
 * retracted). The same query backs the declare path and the projection
 * reducer, so the recorded flag always says what the CLI said.
 */
export function openQuestTitles(database: Database): { id: string; title: string }[] {
  return database
    .query(
      "SELECT id, title FROM quests WHERE ended_at IS NULL AND merged_into IS NULL AND retracted_at IS NULL AND state NOT IN ('done', 'abandoned')",
    )
    .all() as { id: string; title: string }[];
}

/** `judgeTitleQuality` against the database's open quests. */
export function judgeQuestTitle(database: Database, proposed: string): TitleVerdict {
  return judgeTitleQuality(proposed, openQuestTitles(database));
}
