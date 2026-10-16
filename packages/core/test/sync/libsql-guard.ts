/**
 * Bun preload for `offline.test.ts`: any module loaded from the
 * `@libsql/client` package (any entry point) is replaced by one that throws
 * `LIBSQL_GUARD`, proving the offline path never loads the network module.
 *
 * `onLoad` rather than `onResolve`: Bun 1.3.14 hands runtime `onResolve`
 * the already-resolved path, and throwing from it segfaults the process.
 */
import { plugin } from "bun";

plugin({
  name: "libsql-guard",
  setup(build) {
    build.onLoad({ filter: /[\\/]@libsql[\\/]client[\\/]/ }, (args) => ({
      // The stub export lets `import { createClient }` link, so evaluation
      // (and the throw) is reached instead of a missing-export error.
      contents: `export const createClient = undefined;\nthrow new Error(${JSON.stringify(`LIBSQL_GUARD: ${args.path} was loaded`)});`,
      loader: "js",
    }));
  },
});
