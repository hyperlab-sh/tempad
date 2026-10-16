import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mondayCollector } from "../src/collect/monday.ts";
import type { Config } from "../src/config/env.ts";
import { openDatabase } from "../src/db/database.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures/monday");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeConfig(home = "/tmp/tempad-test-home"): Config {
  return {
    mondayApiToken: "test-token",
    mondayUser: "1234567",
    ghUser: "svallory",
    ghOrgs: ["mosaicstg"],
    ghIncludePersonal: false,
    ghToken: undefined,
    gitAuthorEmails: ["me@saulo.engineer"],
    claudeDirs: [],
    hostSlug: "test-host",
    tz: "America/Sao_Paulo",
    since: "2026-07-01",
    syncToken: "unused",
    home,
  };
}

let database: Database;
let dbPath: string;
let callLog: string[];
let complexityAttempts: number;

function dispatchFetch(): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const query = body.query;
    callLog.push(query.trim().split("\n")[0] ?? "");

    if (query.includes("me {")) {
      return jsonResponse(loadFixture("me"));
    }

    if (query.includes("boards(limit:")) {
      const page = body.variables.page;
      return jsonResponse(
        page === 1 ? loadFixture("boards-page-1") : loadFixture("boards-page-2-empty"),
      );
    }

    if (query.includes("next_items_page(cursor:")) {
      return jsonResponse(loadFixture("board-111-items-page-2"));
    }

    if (query.includes("items_page(limit:")) {
      const boardId = (body.variables.boardId as string[])[0];
      const hasFilter = body.variables.params !== undefined && body.variables.params !== null;

      if (boardId === "111") {
        return jsonResponse(loadFixture("board-111-items-page-1"));
      }

      if (boardId === "222") {
        if (hasFilter) {
          return jsonResponse(loadFixture("board-222-rule-rejected"));
        }
        return jsonResponse(loadFixture("board-222-items-unfiltered"));
      }

      if (boardId === "333") {
        complexityAttempts++;
        if (complexityAttempts === 1) {
          return jsonResponse(loadFixture("complexity-error"), 429);
        }
        return jsonResponse({
          data: { boards: [{ items_page: { cursor: null, items: [] } }] },
        });
      }

      if (boardId === "444") {
        complexityAttempts++;
        if (!hasFilter) {
          throw new Error("board 444 should never be queried without the last-updated filter");
        }
        return jsonResponse(loadFixture("complexity-error-persistent"), 429);
      }
    }

    throw new Error(`Unhandled query in test fetch mock: ${query}`);
  }) as typeof fetch;
}

beforeEach(() => {
  dbPath = `/tmp/tempad-monday-test-${Math.random().toString(36).slice(2)}.db`;
  database = openDatabase(dbPath);
  callLog = [];
  complexityAttempts = 0;
});

afterEach(() => {
  database.close();
});

describe("mondayCollector", () => {
  test("filters by assignee id and by name, extracts columns by type, follows cursor", async () => {
    const summary = await mondayCollector.sync(database, makeConfig(), {
      fetch: dispatchFetch(),
    });

    expect(summary.source).toBe("monday");
    expect(summary.inserted).toBe(3);
    expect(summary.updated).toBe(0);

    const rows = database
      .query(
        "SELECT id, board_id, status, timeline_start, timeline_end, time_tracked_seconds, assignees FROM monday_items ORDER BY id",
      )
      .all() as {
      id: number;
      board_id: number;
      status: string | null;
      timeline_start: string | null;
      timeline_end: string | null;
      time_tracked_seconds: number | null;
      assignees: string;
    }[];

    expect(rows.map((row) => row.id)).toEqual([1001, 1003, 2001]);

    const byId = new Map(rows.map((row) => [row.id, row]));

    const matchedById = byId.get(1001);
    expect(matchedById?.status).toBe("Working on it");
    expect(matchedById?.timeline_start).toBe("2026-08-01");
    expect(matchedById?.timeline_end).toBe("2026-08-15");
    expect(matchedById?.time_tracked_seconds).toBe(5400);
    expect(JSON.parse(matchedById?.assignees ?? "[]")).toEqual([
      { id: "1234567", name: "Saulo Vallory" },
    ]);

    const matchedByName = byId.get(1003);
    expect(matchedByName).toBeDefined();
    expect(matchedByName?.status).toBe("Stuck");

    const notAssigned = rows.find((row) => row.id === 1002);
    expect(notAssigned).toBeUndefined();
  });

  test("extracts columns by type, not by column id (board 222 uses a differently-named people column)", async () => {
    database
      .query(
        "INSERT INTO sync_state (source, last_sync_at, cursor) VALUES ('monday', '2026-08-01T00:00:00Z', NULL)",
      )
      .run();

    await mondayCollector.sync(database, makeConfig(), { fetch: dispatchFetch() });

    const boardsFixture = loadFixture("boards-page-1") as {
      data: { boards: { id: string; columns: { id: string; type: string }[] }[] };
    };
    const board111People = boardsFixture.data.boards
      .find((board) => board.id === "111")
      ?.columns.find((column) => column.type === "people")?.id;
    const board222People = boardsFixture.data.boards
      .find((board) => board.id === "222")
      ?.columns.find((column) => column.type === "people")?.id;
    expect(board111People).toBe("person");
    expect(board222People).toBe("people8");
    expect(board111People).not.toBe(board222People);

    const row = database.query("SELECT status FROM monday_items WHERE id = 2001").get() as {
      status: string | null;
    } | null;
    expect(row?.status).toBe("To Do");
  });

  test("falls back to unfiltered pull when the last-updated rule is rejected", async () => {
    database
      .query(
        "INSERT INTO sync_state (source, last_sync_at, cursor) VALUES ('monday', '2026-08-01T00:00:00Z', NULL)",
      )
      .run();

    const summary = await mondayCollector.sync(database, makeConfig(), {
      fetch: dispatchFetch(),
    });

    expect(summary.warnings.length).toBe(1);
    expect(summary.warnings[0]).toContain("board 222");
    expect(summary.warnings[0]).toContain("falling back");

    const row = database.query("SELECT id FROM monday_items WHERE id = 2001").get();
    expect(row).not.toBeNull();
  });

  test("retries once on a complexity error then succeeds", async () => {
    const config = makeConfig();

    const originalDispatch = dispatchFetch();
    const fetchWithThirdBoard: typeof fetch = (async (url, init) => {
      const parsed = JSON.parse(String((init as RequestInit).body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (parsed.query.includes("boards(limit:") && parsed.variables.page === 1) {
        return jsonResponse({
          data: {
            boards: [{ id: "333", name: "Retry Board", columns: [] }],
          },
        });
      }
      if (parsed.query.includes("boards(limit:") && parsed.variables.page === 2) {
        return jsonResponse({ data: { boards: [] } });
      }
      return originalDispatch(url, init);
    }) as typeof fetch;

    const summary = await mondayCollector.sync(database, config, { fetch: fetchWithThirdBoard });

    expect(complexityAttempts).toBe(2);
    expect(summary.inserted).toBe(0);
    expect(summary.warnings.length).toBe(0);
  });

  test("propagates a retry-exhausted complexity error and fails the source (no fallback masking it)", async () => {
    const config = makeConfig();

    database
      .query(
        "INSERT INTO sync_state (source, last_sync_at, cursor) VALUES ('monday', '2026-08-01T00:00:00Z', NULL)",
      )
      .run();

    const originalDispatch = dispatchFetch();
    const fetchWithFourthBoard: typeof fetch = (async (url, init) => {
      const parsed = JSON.parse(String((init as RequestInit).body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (parsed.query.includes("boards(limit:") && parsed.variables.page === 1) {
        return jsonResponse({
          data: {
            boards: [{ id: "444", name: "Always Complex Board", columns: [] }],
          },
        });
      }
      if (parsed.query.includes("boards(limit:") && parsed.variables.page === 2) {
        return jsonResponse({ data: { boards: [] } });
      }
      return originalDispatch(url, init);
    }) as typeof fetch;

    await expect(
      mondayCollector.sync(database, config, { fetch: fetchWithFourthBoard }),
    ).rejects.toThrow("Complexity budget exhausted");

    expect(complexityAttempts).toBe(4);

    const syncState = database
      .query("SELECT last_sync_at FROM sync_state WHERE source = 'monday'")
      .get() as { last_sync_at: string } | null;
    expect(syncState?.last_sync_at).toBe("2026-08-01T00:00:00Z");
  });

  test("idempotent: running twice yields the same row counts", async () => {
    await mondayCollector.sync(database, makeConfig(), { fetch: dispatchFetch() });
    const firstCount = (
      database.query("SELECT COUNT(*) as count FROM monday_items").get() as {
        count: number;
      }
    ).count;

    complexityAttempts = 0;
    const secondSummary = await mondayCollector.sync(database, makeConfig(), {
      fetch: dispatchFetch(),
    });
    const secondCount = (
      database.query("SELECT COUNT(*) as count FROM monday_items").get() as {
        count: number;
      }
    ).count;

    expect(secondCount).toBe(firstCount);
    expect(secondSummary.inserted).toBe(0);
    expect(secondSummary.updated).toBe(0);
  });

  test("re-syncing after a config change updates org/project even though updated_at is unchanged", async () => {
    const home = mkdtempSync(join(tmpdir(), "tempad-monday-config-"));
    try {
      await mondayCollector.sync(database, makeConfig(home), { fetch: dispatchFetch() });

      const before = database
        .query("SELECT org, project FROM monday_items WHERE id = 1001")
        .get() as { org: string; project: string };
      expect(before.org).toBe("monday");

      writeFileSync(
        join(home, "tempad.toml"),
        `[[boards]]\nname = "Engineering"\norg = "mosaic"\nproject = "campaigns"\n`,
      );

      complexityAttempts = 0;
      const summary = await mondayCollector.sync(database, makeConfig(home), {
        fetch: dispatchFetch(),
      });

      expect(summary.inserted).toBe(0);
      expect(summary.updated).toBe(2);

      const after = database
        .query("SELECT org, project FROM monday_items WHERE id = 1001")
        .get() as { org: string; project: string };
      expect(after.org).toBe("mosaic");
      expect(after.project).toBe("campaigns");

      complexityAttempts = 0;
      const rerun = await mondayCollector.sync(database, makeConfig(home), {
        fetch: dispatchFetch(),
      });
      expect(rerun.inserted).toBe(0);
      expect(rerun.updated).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("prefers the status column titled Status over an earlier status-type column", async () => {
    const priorityFirstFetch: typeof fetch = (async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const query = body.query;

      if (query.includes("me {")) return jsonResponse(loadFixture("me"));

      if (query.includes("boards(limit:")) {
        if (body.variables.page === 1) {
          return jsonResponse({
            data: {
              boards: [
                {
                  id: "555",
                  name: "Campaigns",
                  columns: [
                    { id: "priority", title: "Priority", type: "status" },
                    { id: "status", title: "Status", type: "status" },
                    { id: "person", title: "Assignee", type: "people" },
                  ],
                },
              ],
            },
          });
        }
        return jsonResponse(loadFixture("boards-page-2-empty"));
      }

      if (query.includes("items_page(limit:")) {
        return jsonResponse({
          data: {
            boards: [
              {
                items_page: {
                  cursor: null,
                  items: [
                    {
                      id: "3001",
                      name: "Campaign item",
                      group: { title: "Active" },
                      created_at: "2026-08-01T10:00:00Z",
                      updated_at: "2026-08-20T10:00:00Z",
                      column_values: [
                        {
                          id: "person",
                          type: "people",
                          text: "Saulo Vallory",
                          value: '{"personsAndTeams":[{"id":1234567,"kind":"person"}]}',
                        },
                        { id: "priority", type: "status", text: "High", value: "{}" },
                        { id: "status", type: "status", text: "Working on it", value: "{}" },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        });
      }

      throw new Error(`Unhandled query in test fetch mock: ${query}`);
    }) as typeof fetch;

    await mondayCollector.sync(database, makeConfig(), { fetch: priorityFirstFetch });

    const row = database.query("SELECT status FROM monday_items WHERE id = 3001").get() as {
      status: string | null;
    };
    expect(row.status).toBe("Working on it");
  });
});
