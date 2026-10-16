import type { Database } from "bun:sqlite";
import { recordAlias, resolveIdentity } from "../identity";
import type { Projection } from "./index";

/**
 * Every membership event id that stands for the canonical membership
 * `membershipId`: itself, plus each later `membership.joined` another host
 * wrote for the same (hero, party) while it was open (recorded as aliases).
 * Oldest first, canonical first.
 */
export function membershipOriginals(database: Database, membershipId: string): string[] {
  const aliases = database
    .query(
      "SELECT alias_id FROM identity_aliases WHERE kind = 'membership' AND canonical_id = ? ORDER BY alias_id",
    )
    .all(membershipId) as { alias_id: string }[];
  return [membershipId, ...aliases.map((row) => row.alias_id)];
}

/** The originals of `membershipId` that have not left yet. */
export function openMembershipOriginals(database: Database, membershipId: string): string[] {
  return membershipOriginals(database, membershipId).filter(
    (original) =>
      database.query("SELECT 1 FROM membership_leaves WHERE original_id = ?").get(original) ===
      null,
  );
}

export const partyProjection: Projection = {
  name: "parties",
  tables: ["parties", "memberships", "membership_leaves", "clients"],
  createSql: `
    CREATE TABLE IF NOT EXISTS parties (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, hero_id TEXT NOT NULL, party_id TEXT NOT NULL, joined_at TEXT NOT NULL, left_at TEXT, reason TEXT);
    CREATE TABLE IF NOT EXISTS membership_leaves (original_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);`,
  apply(database, event) {
    const payload = event.payload;
    switch (event.kind) {
      case "party.created": {
        // One party per slug: a later party.created for a slug that exists
        // (another host's `party add`) becomes an alias of the first.
        const existing = database
          .query("SELECT id FROM parties WHERE slug = ? AND id IS NOT ?")
          .get(String(payload.slug), event.subject) as { id: string } | null;
        if (existing) {
          recordAlias(database, "party", event.subject, existing.id);
          return;
        }
        database
          .query(
            "INSERT OR REPLACE INTO parties (id, slug, name, description, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            event.subject,
            String(payload.slug),
            String(payload.name),
            payload.description ? String(payload.description) : null,
            event.at,
          );
        return;
      }
      case "party.reworded":
        database
          .query("UPDATE parties SET name = ?, description = ? WHERE id = ?")
          .run(
            String(payload.name),
            payload.description ? String(payload.description) : null,
            resolveIdentity(database, "party", event.subject),
          );
        return;
      case "membership.joined": {
        const hero = resolveIdentity(database, "hero", String(payload.hero));
        const party = resolveIdentity(database, "party", String(payload.party));
        // One open membership per (hero, party): two hosts that each joined
        // the same party merge into the first open one.
        const open = database
          .query(
            "SELECT id FROM memberships WHERE hero_id = ? AND party_id = ? AND left_at IS NULL AND id IS NOT ?",
          )
          .get(hero, party, event.subject) as { id: string } | null;
        if (open) {
          recordAlias(database, "membership", event.subject, open.id);
          return;
        }
        database
          .query(
            "INSERT OR REPLACE INTO memberships (id, hero_id, party_id, joined_at, left_at, reason) VALUES (?, ?, ?, ?, NULL, NULL)",
          )
          .run(event.subject, hero, party, String(payload.joined ?? event.at));
        return;
      }
      case "membership.left": {
        // A leave ends only the membership it names. When two hosts each
        // joined, the second join is folded into the first's row, but the hero
        // still holds both memberships: the row closes when the last of them
        // has left, so a host that left cannot end one the other host never
        // gave up. With a single original (every single-host log) the first
        // leave closes the row, exactly as before.
        database
          .query("INSERT OR REPLACE INTO membership_leaves (original_id) VALUES (?)")
          .run(event.subject);
        const canonical = resolveIdentity(database, "membership", event.subject);
        if (openMembershipOriginals(database, canonical).length > 0) return;
        database
          .query("UPDATE memberships SET left_at = ?, reason = ? WHERE id = ?")
          .run(event.at, payload.reason ? String(payload.reason) : null, canonical);
        return;
      }
      case "client.created": {
        // One client per slug, same rule as parties.
        const existing = database
          .query("SELECT id FROM clients WHERE slug = ? AND id IS NOT ?")
          .get(String(payload.slug), event.subject) as { id: string } | null;
        if (existing) {
          recordAlias(database, "client", event.subject, existing.id);
          return;
        }
        database
          .query("INSERT OR REPLACE INTO clients (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
          .run(event.subject, String(payload.slug), String(payload.name), event.at);
        return;
      }
      default:
        return;
    }
  },
};
