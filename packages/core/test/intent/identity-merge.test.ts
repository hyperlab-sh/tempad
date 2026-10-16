import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { decodeTime, encodeTime } from "ulid";
import { openDatabase } from "../../src/db/database";
import { currentHeroId, resolveIdentity } from "../../src/intent/identity";
import { rebuildAll } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { projectionSnapshot } from "../sync/helpers";
import { databaseFrom, insertEvents, type LoggedEvent } from "./uid-log";

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

    test("a later rename on the alias host applies to the canonical row", () => {
      const database = mergedDatabase(first, second);
      appendLater(database, 0, "party.reworded", alias.party, { name: "Acme Inc" });
      rebuildAll(database);
      expect(all(database, "SELECT id, name FROM parties")).toEqual([
        { id: canonical.party, name: "Acme Inc" },
      ]);
    });

    test("a leave ends only the membership it names; the row closes with the last one", () => {
      const database = mergedDatabase(first, second);
      appendLater(database, 0, "membership.left", alias.membership, { reason: "moved on" });
      rebuildAll(database);
      // The canonical host's join is still open, so the hero is still a member.
      expect(all(database, "SELECT id, left_at, reason FROM memberships")).toEqual([
        { id: canonical.membership, left_at: null, reason: null },
      ]);

      appendLater(database, 1, "membership.left", canonical.membership, { reason: "really" });
      rebuildAll(database);
      expect(all(database, "SELECT id, left_at, reason FROM memberships")).toEqual([
        { id: canonical.membership, left_at: "2026-09-02T00:00:01.000Z", reason: "really" },
      ]);
    });
  });
}

/** Appends one event on 2026-09-02, `second` seconds in, past everything `mergedDatabase` holds. */
function appendLater(
  database: Database,
  second: number,
  kind: string,
  subject: string,
  payload: object,
): void {
  const at = new Date(Date.parse("2026-09-02T00:00:00.000Z") + second * 1000).toISOString();
  database
    .query(
      `INSERT INTO events (at, recorded_at, actor, session_id, kind, subject, payload, uid)
       VALUES (?, ?, 'hero', NULL, ?, ?, ?, ?)`,
    )
    .run(
      at,
      at,
      kind,
      subject,
      JSON.stringify(payload),
      `${encodeTime(Date.parse(at), 10)}${"0".repeat(16)}`,
    );
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

function createdEvents(
  host: string,
  startSecond: number,
  slugs: { party?: string; client?: string },
): LoggedEvent[] {
  const events: LoggedEvent[] = [];
  if (slugs.party !== undefined) {
    events.push({
      second: startSecond,
      host,
      kind: "party.created",
      subject: `PARTY-${host}`,
      payload: { slug: slugs.party, name: `${slugs.party} (${host})` },
    });
  }
  if (slugs.client !== undefined) {
    events.push({
      second: startSecond + 1,
      host,
      kind: "client.created",
      subject: `CLIENT-${host}`,
      payload: { slug: slugs.client, name: `${slugs.client} (${host})` },
    });
  }
  return events;
}

describe("slugs that differ stay separate", () => {
  // Slugs are compared exactly: `party add` and `client add` look them up with
  // `WHERE slug = ?` on a column with the default BINARY collation, and the
  // UNIQUE index on it is case-sensitive too. Only an identical slug is the
  // same party or client on another host.
  for (const [left, right] of [
    ["acme", "Acme"],
    ["acme", "acme-2"],
    ["acme", "acme "],
  ] as const) {
    test(`'${left}' and '${right}' are two parties and two clients, with no alias`, () => {
      const database = databaseFrom([
        ...createdEvents("laptop", 1, { party: left, client: left }),
        ...createdEvents("desktop", 10, { party: right, client: right }),
      ]);
      expect(all(database, "SELECT id, slug FROM parties ORDER BY slug")).toEqual(
        [
          { id: "PARTY-laptop", slug: left },
          { id: "PARTY-desktop", slug: right },
        ].sort((a, b) => (a.slug < b.slug ? -1 : 1)),
      );
      expect(all(database, "SELECT id, slug FROM clients ORDER BY slug")).toEqual(
        [
          { id: "CLIENT-laptop", slug: left },
          { id: "CLIENT-desktop", slug: right },
        ].sort((a, b) => (a.slug < b.slug ? -1 : 1)),
      );
      expect(all(database, "SELECT * FROM identity_aliases")).toEqual([]);
    });
  }

  test("the same slug merges while its near-miss does not, in one log", () => {
    const database = databaseFrom([
      ...createdEvents("laptop", 1, { party: "acme" }),
      ...createdEvents("desktop", 10, { party: "acme" }),
      ...createdEvents("tablet", 20, { party: "Acme" }),
    ]);
    expect(all(database, "SELECT id, slug FROM parties ORDER BY slug")).toEqual([
      { id: "PARTY-tablet", slug: "Acme" },
      { id: "PARTY-laptop", slug: "acme" },
    ]);
    expect(all(database, "SELECT kind, alias_id, canonical_id FROM identity_aliases")).toEqual([
      { kind: "party", alias_id: "PARTY-desktop", canonical_id: "PARTY-laptop" },
    ]);
  });
});

describe("an older identity that arrives after a host has used its own", () => {
  const OLD = "laptop";
  const NEW = "desktop";

  /** What `hero init`, `party add`, `client add` and `saga add` append on one host. */
  function activity(host: string, startSecond: number): LoggedEvent[] {
    return [
      {
        second: startSecond,
        host,
        kind: "hero.created",
        subject: `HERO-${host}`,
        payload: { name: `Saulo on ${host}` },
      },
      ...createdEvents(host, startSecond + 1, { party: "acme", client: "foo" }),
      {
        second: startSecond + 3,
        host,
        kind: "membership.joined",
        subject: `MEMBERSHIP-${host}`,
        payload: {
          hero: `HERO-${host}`,
          party: `PARTY-${host}`,
          joined: "2026-09-01T00:00:00.000Z",
        },
      },
      {
        second: startSecond + 4,
        host,
        kind: "saga.created",
        subject: `SAGA-${host}`,
        payload: { owner: { kind: "party", id: `PARTY-${host}` }, title: `saga on ${host}` },
      },
      {
        second: startSecond + 5,
        host,
        kind: "quest.created",
        subject: `QUEST-${host}`,
        payload: { owner: { kind: "hero", id: `HERO-${host}` }, title: `quest on ${host}` },
      },
    ];
  }

  test("the older host's ids become canonical and the newer host's activity follows them", () => {
    // `desktop` has used its own hero and party; `laptop`'s older events (lower
    // uids) only reach it now.
    const before = databaseFrom(activity(NEW, 100));
    expect(all(before, "SELECT id FROM heroes")).toEqual([{ id: `HERO-${NEW}` }]);
    expect(all(before, "SELECT owner_id FROM quests")).toEqual([{ owner_id: `HERO-${NEW}` }]);
    expect(all(before, "SELECT * FROM identity_aliases")).toEqual([]);

    insertLate(before, activity(OLD, 1));
    rebuildAll(before);

    expect(all(before, "SELECT id, name FROM heroes")).toEqual([
      { id: `HERO-${OLD}`, name: `Saulo on ${OLD}` },
    ]);
    expect(all(before, "SELECT id, slug FROM parties")).toEqual([
      { id: `PARTY-${OLD}`, slug: "acme" },
    ]);
    expect(all(before, "SELECT id, slug FROM clients")).toEqual([
      { id: `CLIENT-${OLD}`, slug: "foo" },
    ]);
    expect(currentHeroId(before)).toBe(`HERO-${OLD}`);
    expect(all(before, "SELECT id, hero_id, party_id FROM memberships")).toEqual([
      { id: `MEMBERSHIP-${OLD}`, hero_id: `HERO-${OLD}`, party_id: `PARTY-${OLD}` },
    ]);
    // Rows the newer host wrote against its own ids now hang off the canonical ones.
    expect(all(before, "SELECT id, owner_kind, owner_id FROM sagas ORDER BY id")).toEqual([
      { id: `SAGA-${NEW}`, owner_kind: "party", owner_id: `PARTY-${OLD}` },
      { id: `SAGA-${OLD}`, owner_kind: "party", owner_id: `PARTY-${OLD}` },
    ]);
    expect(all(before, "SELECT id, owner_kind, owner_id FROM quests ORDER BY id")).toEqual([
      { id: `QUEST-${NEW}`, owner_kind: "hero", owner_id: `HERO-${OLD}` },
      { id: `QUEST-${OLD}`, owner_kind: "hero", owner_id: `HERO-${OLD}` },
    ]);
    expect(
      all(before, "SELECT kind, alias_id, canonical_id FROM identity_aliases ORDER BY kind"),
    ).toEqual([
      { kind: "client", alias_id: `CLIENT-${NEW}`, canonical_id: `CLIENT-${OLD}` },
      { kind: "hero", alias_id: `HERO-${NEW}`, canonical_id: `HERO-${OLD}` },
      { kind: "membership", alias_id: `MEMBERSHIP-${NEW}`, canonical_id: `MEMBERSHIP-${OLD}` },
      { kind: "party", alias_id: `PARTY-${NEW}`, canonical_id: `PARTY-${OLD}` },
    ]);
  });

  test("the projections equal a from-scratch rebuild of the same events", () => {
    const events = [...activity(NEW, 100)];
    const database = databaseFrom(events);
    const late = activity(OLD, 1);
    insertLate(database, late);
    rebuildAll(database);

    const scratch = databaseFrom([...events, ...late]);
    expect(projectionSnapshot(database)).toEqual(projectionSnapshot(scratch));
    // And not a projection that was already canonical on the older host's ids.
    expect(currentHeroId(scratch)).toBe(`HERO-${OLD}`);
  });
});

/** Inserts `events` into a database that already holds newer ones, as a pull would. */
function insertLate(database: Database, events: LoggedEvent[]): void {
  insertEvents(database, events);
}

describe("one hero in two hosts' memberships", () => {
  function joined(second: number, host: string): LoggedEvent {
    return {
      second,
      host,
      kind: "membership.joined",
      subject: `MEMBERSHIP-${host}`,
      payload: { hero: "HERO", party: "PARTY", joined: "2026-09-01T00:00:00.000Z" },
    };
  }
  function left(second: number, host: string, reason: string): LoggedEvent {
    return {
      second,
      host,
      kind: "membership.left",
      subject: `MEMBERSHIP-${host}`,
      payload: { reason },
    };
  }
  const SETUP: LoggedEvent[] = [
    { second: 1, host: "a", kind: "hero.created", subject: "HERO", payload: { name: "S" } },
    {
      second: 2,
      host: "a",
      kind: "party.created",
      subject: "PARTY",
      payload: { slug: "acme", name: "Acme" },
    },
  ];
  function rows(database: Database): unknown[] {
    return all(database, "SELECT id, left_at, reason FROM memberships ORDER BY id");
  }
  const at = (second: number) =>
    new Date(Date.parse("2026-09-01T10:00:00.000Z") + second * 1000).toISOString();

  test("one host leaving does not end a membership the other host still holds", () => {
    const database = databaseFrom([
      ...SETUP,
      joined(3, "a"),
      joined(4, "b"),
      left(10, "a", "moved"),
    ]);
    expect(rows(database)).toEqual([{ id: "MEMBERSHIP-a", left_at: null, reason: null }]);
  });

  test("the row closes with the last leave, whichever host leaves last", () => {
    const aFirst = databaseFrom([
      ...SETUP,
      joined(3, "a"),
      joined(4, "b"),
      left(10, "a", "first"),
      left(11, "b", "last"),
    ]);
    expect(rows(aFirst)).toEqual([{ id: "MEMBERSHIP-a", left_at: at(11), reason: "last" }]);

    const bFirst = databaseFrom([
      ...SETUP,
      joined(3, "a"),
      joined(4, "b"),
      left(10, "b", "first"),
      left(11, "a", "last"),
    ]);
    expect(rows(bFirst)).toEqual([{ id: "MEMBERSHIP-a", left_at: at(11), reason: "last" }]);
  });

  test("a third host joining while the row is open folds in, and all three must leave", () => {
    const events = [
      ...SETUP,
      joined(3, "a"),
      joined(4, "b"),
      left(5, "a", "a left"),
      joined(6, "c"),
      left(7, "b", "b left"),
    ];
    expect(rows(databaseFrom(events))).toEqual([
      { id: "MEMBERSHIP-a", left_at: null, reason: null },
    ]);
    expect(rows(databaseFrom([...events, left(8, "c", "c left")]))).toEqual([
      { id: "MEMBERSHIP-a", left_at: at(8), reason: "c left" },
    ]);
  });

  test("a join after every membership has left opens a new row", () => {
    const database = databaseFrom([...SETUP, joined(3, "a"), left(4, "a", "gone"), joined(5, "b")]);
    expect(rows(database)).toEqual([
      { id: "MEMBERSHIP-a", left_at: at(4), reason: "gone" },
      { id: "MEMBERSHIP-b", left_at: null, reason: null },
    ]);
    expect(all(database, "SELECT * FROM identity_aliases WHERE kind = 'membership'")).toEqual([]);
  });

  test("a single host's join and leave close the row exactly as before", () => {
    const database = databaseFrom([...SETUP, joined(3, "a"), left(4, "a", "gone")]);
    expect(rows(database)).toEqual([{ id: "MEMBERSHIP-a", left_at: at(4), reason: "gone" }]);
  });

  test("the order the events are handed over in does not change the result", () => {
    const events = [...SETUP, joined(3, "a"), joined(4, "b"), left(10, "a", "x")];
    expect(projectionSnapshot(databaseFrom([...events].reverse()))).toEqual(
      projectionSnapshot(databaseFrom(events)),
    );
  });
});
