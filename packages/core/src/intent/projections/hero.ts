import { IDENTITY_ALIASES_SQL, recordAlias } from "../identity";
import type { Projection } from "./index";

export const heroProjection: Projection = {
  name: "heroes",
  // identity_aliases is owned here because this projection is registered
  // first: rebuildAll clears it before any reducer records an alias.
  tables: ["heroes", "identity_aliases"],
  createSql: `CREATE TABLE IF NOT EXISTS heroes (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    ${IDENTITY_ALIASES_SQL};`,
  apply(database, event) {
    if (event.kind !== "hero.created") return;
    // One hero overall: the first hero.created in replay order is canonical,
    // a later one (another host's `hero init`) becomes its alias.
    const canonical = database
      .query("SELECT id FROM heroes WHERE id IS NOT ? ORDER BY created_at, id LIMIT 1")
      .get(event.subject) as { id: string } | null;
    if (canonical) {
      recordAlias(database, "hero", event.subject, canonical.id);
      return;
    }
    database
      .query("INSERT OR REPLACE INTO heroes (id, name, created_at) VALUES (?, ?, ?)")
      .run(event.subject, String(event.payload.name), event.at);
  },
};
