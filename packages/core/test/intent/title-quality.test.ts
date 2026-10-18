import { describe, expect, test } from "bun:test";
import { judgeTitleQuality, type TitleVerdictKind } from "../../src/intent/title-quality";

const NO_QUESTS: { id: string; title: string }[] = [];

const ROWS: { title: string; verdict: TitleVerdictKind; note?: string }[] = [
  // Bead examples.
  { title: "fix stuff", verdict: "vague" },
  { title: "S1", verdict: "vague" },
  { title: "Release coordination", verdict: "vague" },
  // The bead's ok example.
  { title: "Fix the sync token refresh", verdict: "ok" },
  // Codes.
  { title: "Q2", verdict: "vague" },
  { title: "42", verdict: "vague" },
  { title: "s17", verdict: "vague" },
  { title: "1", verdict: "vague" },
  // Fewer than 3 words.
  { title: "ship it", verdict: "vague" },
  { title: "cleanup", verdict: "vague" },
  { title: "follow up", verdict: "vague" },
  { title: "fix the bug", verdict: "vague" }, // only generic words + stop word
  // No word longer than 3 letters.
  { title: "fix the api", verdict: "vague" },
  { title: "run db fix", verdict: "vague" },
  // Only generic words (longer than 3 words, long words present).
  { title: "fix stuff and things", verdict: "vague" },
  { title: "misc cleanup and leftovers", verdict: "vague" },
  { title: "coordination updates and followups", verdict: "vague" },
  { title: "tests wip todo changes", verdict: "vague" },
  // Ok titles.
  { title: "Ship the marko-ui port", verdict: "ok" },
  { title: "Rebuild the sync engine on ULIDs", verdict: "ok" },
  { title: "Reduce doubts in verifier windows", verdict: "ok" },
  { title: "Fix walk order", verdict: "ok" }, // short but has a word >3 letters and is specific
  { title: "Draft push-sync spec", verdict: "ok" },
  { title: "Evaluate session kind classification", verdict: "ok" },
  // "test" is generic but the title names a specific subject.
  { title: "Test the classifier repair path", verdict: "ok" },
  { title: "Update the install docs", verdict: "ok" },
];

describe("judgeTitleQuality", () => {
  for (const row of ROWS) {
    test(`${JSON.stringify(row.title)} -> ${row.verdict}${row.note ? ` (${row.note})` : ""}`, () => {
      expect(judgeTitleQuality(row.title, NO_QUESTS).verdict).toBe(row.verdict);
    });
  }

  test("an empty or blank title is vague", () => {
    expect(judgeTitleQuality("", NO_QUESTS).verdict).toBe("vague");
    expect(judgeTitleQuality("   ", NO_QUESTS).verdict).toBe("vague");
  });

  describe("duplicates", () => {
    const existing = [
      { id: "q1", title: "Fix the sync token refresh" },
      { id: "q2", title: "Ship marko-ui" },
    ];

    test.each([
      "Fix the sync token refresh",
      "fix the sync token refresh",
      "Fix  the   Sync Token Refresh",
      "Fix sync, token refresh", // punctuation and the/a/an/for/of stripped
      "fix sync token refresh",
      "The ship marko-ui",
    ])("%s is a duplicate", (title) => {
      const verdict = judgeTitleQuality(title, existing);
      expect(verdict.verdict).toBe("duplicate");
      if (title.toLowerCase().includes("marko")) {
        expect(verdict.duplicateOf).toBe("q2");
        expect(verdict.reason).toBe("duplicate:q2");
      } else {
        expect(verdict.duplicateOf).toBe("q1");
        expect(verdict.reason).toBe("duplicate:q1");
      }
    });

    test.each(["Fix the sync token expiry", "Ship marko-ui v2", "Document the token refresh"])(
      "%s is not a duplicate",
      (title) => {
        expect(judgeTitleQuality(title, existing).verdict).not.toBe("duplicate");
      },
    );

    test("the reason carries the duplicate's id", () => {
      expect(judgeTitleQuality("ship Marko-UI", existing)).toEqual({
        verdict: "duplicate",
        reason: "duplicate:q2",
        duplicateOf: "q2",
      });
    });
  });
});
