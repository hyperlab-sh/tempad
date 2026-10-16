import { ENV_VARS, type EnvVar } from "../config/env.ts";

/** The command-line flag that carries a variable: `MONDAY_API_TOKEN` is `--monday-api-token`. */
export function flagNameFor(variable: EnvVar): string {
  return variable.name.toLowerCase().replaceAll("_", "-");
}

/**
 * Quotes a value the way `parseDotEnv` unquotes it (one outer pair of double quotes,
 * nothing inside is an escape), so what `tempad init` writes is what `loadConfig` reads.
 * Values with whitespace, quotes, `#` or shell metacharacters are quoted so the file also
 * survives `source`. A value with a line break cannot be represented on one line.
 */
export function formatEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("a value cannot contain a line break");
  return value === "" || /[\s#"'$`\\]/.test(value) ? `"${value}"` : value;
}

/**
 * The text of `<home>/.env`. Every variable of `ENV_VARS` gets a commented description;
 * an optional variable without a value is written commented out, since a blank
 * `GH_TOKEN=` would read back as an empty token rather than as unset. `extras` are
 * lines of an earlier file that `tempad init` does not own; they are carried over verbatim.
 */
export function renderEnvFile(
  values: Readonly<Record<string, string>>,
  extras: Readonly<Record<string, string>> = {},
): string {
  const lines = [
    "# tempad configuration, written by `tempad init`.",
    "# Real environment variables win over this file. Keep it private: it holds secrets.",
  ];
  for (const variable of ENV_VARS) {
    const value = values[variable.name];
    lines.push("", `# ${variable.description}`);
    if (value === undefined || value === "") {
      lines.push(`# ${variable.name}=`);
    } else {
      lines.push(`${variable.name}=${formatEnvValue(value)}`);
    }
  }
  const extraNames = Object.keys(extras);
  if (extraNames.length > 0) {
    lines.push("", "# Other settings kept from the previous file.");
    for (const name of extraNames) lines.push(`${name}=${formatEnvValue(extras[name] ?? "")}`);
  }
  return `${lines.join("\n")}\n`;
}
