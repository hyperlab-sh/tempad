/**
 * The real `SyncRemote`: sqld over HTTP/WebSocket through `@libsql/client`.
 *
 * This is the only file that imports `@libsql/client`, and the sync path
 * loads it with a dynamic `import()` only after `loadSyncConfig` returned an
 * enabled config, so an offline host never resolves the package
 * (`test/sync/offline.test.ts` guards that). The web entry point is used: it
 * speaks only the remote protocols and needs no native binding.
 */
import { createClient, type InValue } from "@libsql/client/web";
import type { SyncConfig } from "./config";
import type { RemoteStatement, SqlValue, SyncRemote } from "./engine";

export function openRemote(config: SyncConfig): SyncRemote {
  const client = createClient({ url: config.url, authToken: config.token });
  return {
    async query(sql: string, args: SqlValue[] = []) {
      const result = await client.execute({ sql, args: args as InValue[] });
      return result.rows.map((row) => {
        const record: Record<string, SqlValue> = {};
        result.columns.forEach((column, index) => {
          record[column] = row[index] as SqlValue;
        });
        return record;
      });
    },
    async write(statements: RemoteStatement[]) {
      await client.batch(
        statements.map((statement) => ({ sql: statement.sql, args: statement.args as InValue[] })),
        "write",
      );
    },
    close() {
      client.close();
    },
  };
}
