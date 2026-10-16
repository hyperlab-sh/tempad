import { childEnvironment } from "../config/child-env.ts";
import { claudeCollector } from "./claude.ts";
import type { CommandRunner } from "./github/request.ts";
import { createGithubCollector } from "./github.ts";
import { mondayCollector } from "./monday.ts";
import type { Collector } from "./types.ts";

/** @internal exported for tests */
export const defaultRunner: CommandRunner = {
  async run(argv, cwd) {
    const proc = Bun.spawn(argv, {
      cwd,
      // git and gh: `gh` reads GH_TOKEN, nothing here needs the other secrets.
      env: childEnvironment(["GH_TOKEN"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  },
};

// Each collector narrows `sync`'s config to the fields it reads. `Collector` is
// method-bivariant, so the map holds them all; `tempad sync` loads the union of the
// selected collectors' `needs` before calling any of them.
export const collectors: Map<Collector["name"], Collector> = new Map();
collectors.set(mondayCollector.name, mondayCollector);
collectors.set(claudeCollector.name, claudeCollector);
collectors.set("github", createGithubCollector({ fetch, runner: defaultRunner }));
