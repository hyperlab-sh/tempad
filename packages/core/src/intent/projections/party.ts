import { recordAlias, resolveIdentity } from "../identity";
import type { Projection } from "./index";

export const partyProjection: Projection = {
  name: "parties",
  tables: ["parties", "memberships", "clients"],
  createSql: `
    CREATE TABLE IF NOT EXISTS parties (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, hero_id TEXT NOT NULL, party_id TEXT NOT NULL, joined_at TEXT NOT NULL, left_at TEXT, reason TEXT);
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
      case "membership.left":
        database
          .query("UPDATE memberships SET left_at = ?, reason = ? WHERE id = ?")
          .run(
            event.at,
            payload.reason ? String(payload.reason) : null,
            resolveIdentity(database, "membership", event.subject),
          );
        return;
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
