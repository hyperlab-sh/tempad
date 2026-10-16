import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mergeWouldCycle, resolveQuest } from "../../src/intent/projections/quest";
import { databaseFrom, databaseFromIncremental, type LoggedEvent } from "./uid-log";

function created(second: number, host: string, id: string): LoggedEvent {
  return {
    second,
    host,
    kind: "quest.created",
    subject: id,
    payload: { owner: { kind: "hero", id: "HERO" }, title: `quest ${id}` },
  };
}

function merged(second: number, host: string, source: string, into: string): LoggedEvent {
  return { second, host, kind: "quest.merged", subject: source, payload: { into } };
}

function mergedInto(database: Database): Record<string, string | null> {
  const rows = database.query("SELECT id, merged_into FROM quests ORDER BY id").all() as {
    id: string;
    merged_into: string | null;
  }[];
  return Object.fromEntries(rows.map((row) => [row.id, row.merged_into]));
}

const QUESTS = [created(1, "a", "Q1"), created(2, "a", "Q2"), created(3, "a", "Q3")];

describe("concurrent quest merges across hosts", () => {
  test("opposite merges: the earlier uid wins and the later is ignored", () => {
    // Host a: Q1 into Q2. Host b, not having seen it: Q2 into Q1.
    const database = databaseFrom([
      ...QUESTS,
      merged(10, "a", "Q1", "Q2"),
      merged(11, "b", "Q2", "Q1"),
    ]);
    expect(mergedInto(database)).toEqual({ Q1: "Q2", Q2: null, Q3: null });
    expect(resolveQuest(database, "Q1")).toBe("Q2");
    expect(resolveQuest(database, "Q2")).toBe("Q2");
  });

  test("the winner follows uid order, not which host wrote it", () => {
    const database = databaseFrom([
      ...QUESTS,
      merged(11, "a", "Q1", "Q2"),
      merged(10, "b", "Q2", "Q1"),
    ]);
    expect(mergedInto(database)).toEqual({ Q1: null, Q2: "Q1", Q3: null });
    expect(resolveQuest(database, "Q2")).toBe("Q1");
  });

  test("a longer loop is cut at the merge that closes it", () => {
    const database = databaseFrom([
      ...QUESTS,
      merged(10, "a", "Q1", "Q2"),
      merged(11, "b", "Q2", "Q3"),
      merged(12, "c", "Q3", "Q1"),
    ]);
    expect(mergedInto(database)).toEqual({ Q1: "Q2", Q2: "Q3", Q3: null });
    expect(resolveQuest(database, "Q1")).toBe("Q3");
  });

  test("a merge of a quest into itself is ignored", () => {
    const database = databaseFrom([...QUESTS, merged(10, "a", "Q1", "Q1")]);
    expect(mergedInto(database)).toEqual({ Q1: null, Q2: null, Q3: null });
  });

  test("merging into a quest that is already merged away chains and still resolves", () => {
    const database = databaseFrom([
      ...QUESTS,
      merged(10, "a", "Q1", "Q2"),
      merged(11, "b", "Q3", "Q1"),
    ]);
    expect(mergedInto(database)).toEqual({ Q1: "Q2", Q2: null, Q3: "Q1" });
    expect(resolveQuest(database, "Q3")).toBe("Q2");
  });

  test("the same quest merged into two targets keeps the later merge and creates no loop", () => {
    const database = databaseFrom([
      ...QUESTS,
      merged(10, "a", "Q1", "Q2"),
      merged(11, "b", "Q1", "Q3"),
    ]);
    expect(mergedInto(database)).toEqual({ Q1: "Q3", Q2: null, Q3: null });
  });

  test("a merge that would cycle through an overwritten edge is judged on the edges as they stand", () => {
    // Q1 into Q2, then Q1 re-pointed at Q3, then Q2 into Q1: Q1's edge to Q2 is
    // gone, so Q2 into Q1 closes nothing.
    const database = databaseFrom([
      ...QUESTS,
      merged(10, "a", "Q1", "Q2"),
      merged(11, "a", "Q1", "Q3"),
      merged(12, "b", "Q2", "Q1"),
    ]);
    expect(mergedInto(database)).toEqual({ Q1: "Q3", Q2: "Q1", Q3: null });
    expect(resolveQuest(database, "Q2")).toBe("Q3");
  });

  test("the incremental path and a rebuild agree", () => {
    const events = [
      ...QUESTS,
      merged(10, "a", "Q1", "Q2"),
      merged(11, "b", "Q2", "Q1"),
      merged(12, "c", "Q3", "Q2"),
    ];
    const rebuilt = databaseFrom(events);
    const incremental = databaseFromIncremental(events);
    expect(mergedInto(incremental)).toEqual(mergedInto(rebuilt));
    expect(mergedInto(rebuilt)).toEqual({ Q1: "Q2", Q2: null, Q3: "Q2" });
  });

  test("the order the events are handed over in does not change the result", () => {
    const events = [...QUESTS, merged(10, "a", "Q1", "Q2"), merged(11, "b", "Q2", "Q1")];
    const first = databaseFrom(events);
    const second = databaseFrom([...events].reverse());
    expect(mergedInto(second)).toEqual(mergedInto(first));
  });

  test("mergeWouldCycle sees through a chain and tolerates an unknown quest", () => {
    const database = databaseFrom([
      ...QUESTS,
      merged(10, "a", "Q1", "Q2"),
      merged(11, "a", "Q2", "Q3"),
    ]);
    expect(mergeWouldCycle(database, "Q3", "Q1")).toBe(true);
    expect(mergeWouldCycle(database, "Q1", "Q3")).toBe(false);
    expect(mergeWouldCycle(database, "Q3", "NO-SUCH-QUEST")).toBe(false);
    expect(mergeWouldCycle(database, "Q1", "Q1")).toBe(true);
  });
});
