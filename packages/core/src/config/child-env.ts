import { ENV_VARS } from "./env.ts";

/**
 * The environment for a child process tempad spawns: the parent's, minus every secret tempad
 * itself reads (`secret: true` in `ENV_VARS`: `TEMPAD_SYNC_TOKEN`, `MONDAY_API_TOKEN`,
 * `GH_TOKEN`). A child gets one back only by being named in `keep`, because it uses it (the
 * `gh` calls need `GH_TOKEN`); the classifier's `claude -p`, the detached `w5 run` and anything
 * else has no use for a server credential and must never inherit it. Variables tempad does not
 * own (`ANTHROPIC_API_KEY`, `PATH`, ...) pass through untouched.
 */
export function childEnvironment(
  keep: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const secret = new Set(
    ENV_VARS.filter((variable) => variable.secret && !keep.includes(variable.name)).map(
      (variable) => variable.name,
    ),
  );
  const scrubbed: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && !secret.has(name)) scrubbed[name] = value;
  }
  return scrubbed;
}
