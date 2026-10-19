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
  // A title that names any concrete object is ok no matter how short, and
  // regardless of case: every token that is neither generic nor a stop word
  // is content the verifier can match work against (r2).
  { title: "fix the api", verdict: "ok" }, // api is a concrete object here
  { title: "run db fix", verdict: "ok" },
  // Review r1/r2 counterexamples: short titles that name a concrete object or
  // a technical token are ok, case- and script-insensitively.
  { title: "Fix deadlocks", verdict: "ok" },
  { title: "Rotate credentials", verdict: "ok" },
  { title: "Upgrade PostgreSQL", verdict: "ok" },
  { title: "Add SSH key", verdict: "ok" },
  { title: "Add ssh key", verdict: "ok" }, // case is irrelevant
  { title: "Fix JWT TTL", verdict: "ok" },
  { title: "Fix jwt ttl", verdict: "ok" }, // case is irrelevant
  { title: "Fix C# bug", verdict: "ok" }, // language token
  { title: "Fix C++ bug", verdict: "ok" }, // language token
  { title: "修复同步令牌刷新", verdict: "ok" }, // non-Latin words are content
  { title: "Back up S3 buckets", verdict: "ok" }, // letter-digit identifier
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

    test("C# and C++ stay distinct titles", () => {
      // Language-token punctuation survives normalization, so the tokenizer
      // can tell the two languages apart (r2).
      expect(
        judgeTitleQuality("Install the C# compiler", [
          { id: "q3", title: "Install the C++ compiler" },
        ]).verdict,
      ).toBe("ok");
      // ...while the same language token in different cases still collides.
      expect(
        judgeTitleQuality("install the c# compiler", [
          { id: "q4", title: "Install the C# compiler" },
        ]).verdict,
      ).toBe("duplicate");
      expect(
        judgeTitleQuality("Use Node.js streams", [{ id: "q5", title: "use node.js streams" }])
          .verdict,
      ).toBe("duplicate");
    });
  });
});
