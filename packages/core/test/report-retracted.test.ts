import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db/database.ts";
import { applyIncremental } from "../src/intent/projections/index.ts";
import { registerAllProjections } from "../src/intent/projections/register.ts";
import { EventStore } from "../src/intent/store.ts";
import { dailyReport } from "../src/report/daily.ts";
import { hourlyReport } from "../src/report/hourly.ts";
import {
  queryDismissedMinutesByQuest,
  queryQuests,
  querySideQuests,
  queryStints,
  queryStintTraceIntervals,
} from "../src/report/intent-queries.ts";
import { projectReport } from "../src/report/project.ts";
import { weeklyReport } from "../src/report/weekly.ts";
import { REPORT_CONFIG, seedReportFixtures } from "./fixtures/report-golden/seed.ts";

registerAllProjections();

const RANGE = { from: "2026-09-01", to: "2026-09-01", timeZone: REPORT_CONFIG.tz };
const MAIN = "Polish the report output";
const SIDE = "Investigate flaky commit grouping";

/**
 * Retracts the quest rows only, leaving their stints and traces live: the state
 * the lead produced by hand, and the one every report must still hide.
 */
function seedRetracted(...questIds: string[]) {
  const database = openDatabase(":memory:");
  seedReportFixtures(database);
  const store = new EventStore(database);
  for (const id of questIds) {
    applyIncremental(
      database,
      store.append({
        actor: "hero",
        kind: "retracted",
        subject: id,
        payload: { retracts: id, reason: "created by mistake" },
      }),
    );
  }
  return database;
}

describe("reports hide a retracted quest", () => {
  test("fixture control: the quests are visible before retraction", () => {
    const database = seedRetracted();
    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(output).toContain(MAIN);
    expect(output).toContain(SIDE);
    database.close();
  });

  test("daily report names neither the quest nor its side quest", () => {
    const database = seedRetracted("quest-1", "quest-2");
    const output = dailyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(output).not.toContain(MAIN);
    expect(output).not.toContain(SIDE);
    // The time itself is real work and stays; only the quest label goes.
    expect(output).toContain("polish daily/hourly report output");
    database.close();
  });

  test("project report names neither quest", () => {
    const database = seedRetracted("quest-1", "quest-2");
    const output = projectReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(output).not.toContain(MAIN);
    expect(output).not.toContain(SIDE);
    database.close();
  });

  test("hourly report names neither quest", () => {
    const database = seedRetracted("quest-1", "quest-2");
    const output = hourlyReport.render(database, REPORT_CONFIG, {
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(output).not.toContain(MAIN);
    expect(output).not.toContain(SIDE);
    database.close();
  });

  test("weekly report counts no retracted side quest", () => {
    const control = seedRetracted();
    const before = weeklyReport.render(control, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-04",
    });
    control.close();

    const database = seedRetracted("quest-1", "quest-2");
    const after = weeklyReport.render(database, REPORT_CONFIG, {
      from: "2026-08-31",
      to: "2026-09-04",
    });
    expect(after).not.toBe(before);
    expect(after).not.toContain(MAIN);
    expect(querySideQuests(database, RANGE)).toEqual([]);
    database.close();
  });

  test("queries: stints lose the quest label, quest and side-quest lists are empty", () => {
    const database = seedRetracted("quest-1", "quest-2");
    const stints = queryStints(database, RANGE);
    expect(stints.length).toBeGreaterThan(0);
    for (const stint of stints) {
      expect(stint.questTitle).toBeNull();
    }
    expect(queryQuests(database, RANGE)).toEqual([]);
    expect(querySideQuests(database, RANGE)).toEqual([]);
    for (const row of queryStintTraceIntervals(database, RANGE)) {
      expect(row.questTitle).toBeNull();
    }
    expect(queryDismissedMinutesByQuest(database, RANGE)).toEqual([]);
    database.close();
  });

  test("dismissed short work is not credited to a retracted quest", () => {
    const seed = (...retract: string[]) => {
      const database = seedRetracted(...retract);
      database.exec(
        `INSERT INTO stints (id, quest_id, outcome, opened_at, closed_at, dismissed_at, revision)
         VALUES ('stint-short', 'quest-1', 'quick look', '2026-09-01T14:00:00.000Z', '2026-09-01T14:03:00.000Z', '2026-09-01T14:03:00.000Z', 1)`,
      );
      database.exec(
        `INSERT INTO traces (id, stint_id, tool, place, source, source_ref, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
         VALUES ('trace-short', 'stint-short', 'edit', '/Users/octocat/work/acme/widgets', 'session', 'session-1', '2026-09-01T14:00:00.000Z', '2026-09-01T14:03:00.000Z', 'hero-1', 'looked', 'checking', '/Users/octocat/work/acme/widgets', 'assistant edit', 0.9, 'model', 'session-1', '2026-09-01T14:03:00.000Z')`,
      );
      database.exec(
        `INSERT INTO trace_links (trace_id, stint_id, linked_at, superseded_at, reason)
         VALUES ('trace-short', 'stint-short', '2026-09-01T14:03:00.000Z', NULL, NULL)`,
      );
      return database;
    };

    const control = seed();
    expect(queryDismissedMinutesByQuest(control, RANGE).map((row) => row.questId)).toEqual([
      "quest-1",
    ]);
    control.close();

    const database = seed("quest-1");
    expect(queryDismissedMinutesByQuest(database, RANGE)).toEqual([]);
    database.close();
  });
});
