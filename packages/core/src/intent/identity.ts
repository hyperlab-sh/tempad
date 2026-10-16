import type { Database } from "bun:sqlite";

/**
 * Cross-host identity merge (docs/specs/push-sync.md, "Identity merge across
 * hosts"). Hosts set up independently each ran `tempad hero init` and usually
 * `party add` / `client add` with the same slugs, so a merged event log holds
 * several `hero.created` events and several `party.created` /
 * `client.created` events per slug, each with its own id.
 *
 * The first created event in uid (replay) order is canonical: one hero
 * overall, one party per slug, one client per slug, and one open membership
 * per (hero, party) pair. A later created event for an identity that already
 * exists inserts no row; it records `alias_id -> canonical_id` in
 * `identity_aliases`, and every reducer that reads such an id from a subject
 * or payload resolves it through `resolveIdentity` before writing.
 *
 * The table is a projection (owned by the `heroes` projection, which is
 * registered first, so it is cleared before any reducer writes to it on
 * rebuild) and is local-only. A single-host log never has duplicates, so it
 * stays empty there and every other projection is unchanged.
 */
export type IdentityKind = "hero" | "party" | "client" | "membership";

export const IDENTITY_ALIASES_SQL =
  "CREATE TABLE IF NOT EXISTS identity_aliases (kind TEXT NOT NULL, alias_id TEXT NOT NULL, canonical_id TEXT NOT NULL, PRIMARY KEY (kind, alias_id))";

/** `id` itself unless it was recorded as an alias of a canonical id. */
export function resolveIdentity(database: Database, kind: IdentityKind, id: string): string {
  const row = database
    .query("SELECT canonical_id FROM identity_aliases WHERE kind = ? AND alias_id = ?")
    .get(kind, id) as { canonical_id: string } | null;
  return row?.canonical_id ?? id;
}

export function recordAlias(
  database: Database,
  kind: IdentityKind,
  aliasId: string,
  canonicalId: string,
): void {
  database
    .query(
      "INSERT OR REPLACE INTO identity_aliases (kind, alias_id, canonical_id) VALUES (?, ?, ?)",
    )
    .run(kind, aliasId, canonicalId);
}

/**
 * Resolves a saga/quest owner `{ kind, id }`: a hero or party id written on
 * another host lands on the canonical one. Other kinds pass through.
 */
export function resolveOwnerIdentity(
  database: Database,
  owner: { kind: string; id: string },
): { kind: string; id: string } {
  if (owner.kind === "hero" || owner.kind === "party" || owner.kind === "client") {
    return { kind: owner.kind, id: resolveIdentity(database, owner.kind, owner.id) };
  }
  return owner;
}

/**
 * The canonical hero's id, or null before `tempad hero init`. The `heroes`
 * projection holds only the canonical hero, so the ORDER BY is a guard that
 * keeps the answer deterministic even on a projection built before aliases
 * existed. Every "which hero" lookup goes through this.
 */
export function currentHeroId(database: Database): string | null {
  const row = database.query("SELECT id FROM heroes ORDER BY created_at, id LIMIT 1").get() as {
    id: string;
  } | null;
  return row?.id ?? null;
}
