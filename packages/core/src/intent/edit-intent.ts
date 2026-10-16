import type { Database } from "bun:sqlite";

export type EditIntent = "reword" | "replace";

function tableExists(database: Database, name: string): boolean {
  return (
    database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    null
  );
}

export function countAttachments(database: Database, entity: "saga" | "quest", id: string): number {
  if (entity === "saga") {
    if (!tableExists(database, "quests")) return 0;
    return (
      database
        .query("SELECT count(*) AS n FROM quests WHERE serves = ? AND retracted_at IS NULL")
        .get(id) as { n: number }
    ).n;
  }
  if (!tableExists(database, "stints")) return 0;
  return (
    database
      .query("SELECT count(*) AS n FROM stints WHERE quest_id = ? AND retracted_at IS NULL")
      .get(id) as {
      n: number;
    }
  ).n;
}

export function assertEditIntent(
  database: Database,
  entity: "saga" | "quest",
  id: string,
  intent: EditIntent | undefined,
): void {
  if (intent !== undefined) return;
  if (countAttachments(database, entity, id) > 0) {
    throw new Error(
      `${entity} ${id} has attachments; use tempad ${entity} reword ${id} "<title>" or tempad ${entity} replace ${id} "<title>" --reason ...`,
    );
  }
}
