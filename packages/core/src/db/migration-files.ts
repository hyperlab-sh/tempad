import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export interface MigrationFile {
  version: number;
  sql: string;
}

/**
 * Every `src/db/migrations/NNNN_*.sql`, in version order. Its own module so a
 * test can stand in a longer chain (a future migration) without files on disk.
 */
export function loadMigrations(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  return files.map((file) => {
    const match = file.match(/^(\d+)_/);
    if (!match?.[1]) {
      throw new Error(`Migration file name must start with a number: ${file}`);
    }
    return {
      version: Number.parseInt(match[1], 10),
      sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
    };
  });
}
