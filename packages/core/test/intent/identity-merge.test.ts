import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { decodeTime, encodeTime } from "ulid";
import { openDatabase } from "../../src/db/database";
import { currentHeroId, resolveIdentity } from "../../src/intent/identity";
import { rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";

registerAllProjections();

interface HostIds {
  hero: string;
  party: string;
  membership: string;
  client: string;
  saga: string;
  quest: string;
}

function hostIds(host: string): HostIds {
  return {
    hero: `HERO-${host}`,
    party: `PARTY-${host}`,
    membership: `MEMBERSHIP-${host}`,
    client: `CLIENT-${host}`,
    saga: `SAGA-${host}`,
    quest: `QUEST-${host}`,
  };
}

/** What `hero init`, `party add acme`, `client add foo`, `saga add`, `quest add` append on one host. */
function hostLog(host: string): { kind: string; subject: string; payload: object }[] {
  const ids = hostIds(host);
  return [
    { kind: "hero.created", subject: ids.hero, payload: { name: `Saulo on ${host}` } },
    {
      kind: "party.created",
      subject: ids.party,
      payload: { slug: "acme", name: `Acme (${host})` },
    },
    {
      kind: "membership.joined",
      subject: ids.membership,
      payload: { hero: ids.hero, party: ids.party, joined: "2026-09-01T00:00:00.000Z" },
    },
    {
      kind: "client.created",
      subject: ids.client,
      payload: { slug: "foo", name: `Foo (${host})` },
    },
    {
      kind: "saga.created",
      subject: ids.saga,
      payload: { owner: { kind: "party", id: ids.party }, title: `saga from ${host}` },
    },
    {
      kind: "quest.created",
      subject: ids.quest,
      payload: {
        owner: { kind: "hero", id: ids.hero },
        serves: ids.saga,
        title: `quest from ${host}`,
      },
    },
  ];
}

/**
 * Two hosts' logs merged by uid: event k of `first` sorts just before event k
 * of `second`. Inserted in a jumbled local id order, as pulls would leave it.
 */
function mergedDatabase(first: string, second: string): Database {
  const database = openDatabase(":memory:");
  const base = Date.parse("2026-09-01T10:00:00.000Z");
  const rows: { uid: string; host: string; kind: string; subject: string; payload: object }[] = [];
  for (const [offset, host] of [first, second].entries()) {
    hostLog(host).forEach((event, index) => {
      const time = base + index * 1000 + offset;
      rows.push({ uid: `${encodeTime(time, 10)}${"0".repeat(16)}`, host, ...event });
    });
  }
  const insert = database.query(
    `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload, uid, sync_host, sync_dirty)
     VALUES (?, ?, 'hero', NULL, ?, ?, ?, ?, ?, 0)`,
  );
  for (const row of [...rows].reverse()) {
    const at = new Date(decodeTime(row.uid)).toISOString();
    insert.run(at, at, row.kind, row.subject, JSON.stringify(row.payload), row.uid, row.host);
  }
  rebuildAll(database);
  return database;
}

function all(database: Database, sql: string): unknown[] {
  return database.query(sql).all();
}

for (const [first, second] of [
  ["laptop", "desktop"],
  ["desktop", "laptop"],
] as const) {
  describe(`identity merge, ${first} first in uid order`, () => {
    const canonical = hostIds(first);
    const alias = hostIds(second);

    test("rebuildAll does not throw and keeps one hero, one party, one client", () => {
      const database = mergedDatabase(first, second);
      expect(all(database, "SELECT id, name FROM heroes")).toEqual([
        { id: canonical.hero, name: `Saulo on ${first}` },
      ]);
      expect(all(database, "SELECT id, slug, name FROM parties")).toEqual([
        { id: canonical.party, slug: "acme", name: `Acme (${first})` },
      ]);
      expect(all(database, "SELECT id, slug, name FROM clients")).toEqual([
        { id: canonical.client, slug: "foo", name: `Foo (${first})` },
      ]);
      expect(currentHeroId(database)).toBe(canonical.hero);
    });

    test("the later identities are recorded as aliases of the canonical ones", () => {
      const database = mergedDatabase(first, second);
      expect(
        all(database, "SELECT kind, alias_id, canonical_id FROM identity_aliases ORDER BY kind"),
      ).toEqual([
        { kind: "client", alias_id: alias.client, canonical_id: canonical.client },
        { kind: "hero", alias_id: alias.hero, canonical_id: canonical.hero },
        { kind: "membership", alias_id: alias.membership, canonical_id: canonical.membership },
        { kind: "party", alias_id: alias.party, canonical_id: canonical.party },
      ]);
      expect(resolveIdentity(database, "party", alias.party)).toBe(canonical.party);
      expect(resolveIdentity(database, "party", canonical.party)).toBe(canonical.party);
    });

    test("every reference lands on the canonical ids", () => {
      const database = mergedDatabase(first, second);
      expect(all(database, "SELECT id, hero_id, party_id, left_at FROM memberships")).toEqual([
        {
          id: canonical.membership,
          hero_id: canonical.hero,
          party_id: canonical.party,
          left_at: null,
        },
      ]);
      expect(all(database, "SELECT id, owner_kind, owner_id FROM sagas ORDER BY id")).toEqual(
        [canonical.saga, alias.saga]
          .sort()
          .map((id) => ({ id, owner_kind: "party", owner_id: canonical.party })),
      );
      expect(all(database, "SELECT id, owner_kind, owner_id FROM quests ORDER BY id")).toEqual(
        [canonical.quest, alias.quest]
          .sort()
          .map((id) => ({ id, owner_kind: "hero", owner_id: canonical.hero })),
      );
    });

    test("a later rename or leave on the alias host applies to the canonical row", () => {
      const database = mergedDatabase(first, second);
      const insert = database.query(
        `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload, uid)
         VALUES ('2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 'hero', NULL, ?, ?, ?, ?)`,
      );
      insert.run(
        "party.reworded",
        alias.party,
        JSON.stringify({ name: "Acme Inc" }),
        `${encodeTime(Date.parse("2026-09-02T00:00:00.000Z"), 10)}${"0".repeat(16)}`,
      );
      insert.run(
        "membership.left",
        alias.membership,
        JSON.stringify({ reason: "moved on" }),
        `${encodeTime(Date.parse("2026-09-02T00:00:01.000Z"), 10)}${"0".repeat(16)}`,
      );
      rebuildAll(database);
      expect(all(database, "SELECT id, name FROM parties")).toEqual([
        { id: canonical.party, name: "Acme Inc" },
      ]);
      expect(all(database, "SELECT id, left_at, reason FROM memberships")).toEqual([
        { id: canonical.membership, left_at: "2026-09-02T00:00:00.000Z", reason: "moved on" },
      ]);
    });
  });
}

test("a single host's log records no alias", () => {
  const database = openDatabase(":memory:");
  const insert = database.query(
    `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload)
     VALUES ('2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', 'hero', NULL, ?, ?, ?)`,
  );
  for (const event of hostLog("laptop")) {
    insert.run(event.kind, event.subject, JSON.stringify(event.payload));
  }
  rebuildAll(database);
  expect(all(database, "SELECT * FROM identity_aliases")).toEqual([]);
  expect(all(database, "SELECT id FROM heroes")).toEqual([{ id: "HERO-laptop" }]);
  expect(all(database, "SELECT party_id FROM memberships")).toEqual([{ party_id: "PARTY-laptop" }]);
});
