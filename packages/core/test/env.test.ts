import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  anthropicApiKey,
  ConfigError,
  type ConfigKey,
  ENV_VARS,
  ignoreWorkingDirectoryEnvFiles,
  isConfigured,
  loadConfig,
  parseDotEnv,
  readDotEnv,
  requireFields,
  tempadHome,
} from "../src/config/env.ts";

const ALL_ENV_NAMES = ENV_VARS.map((variable) => variable.name);
const REQUIRED_ENV_NAMES = ENV_VARS.filter((variable) => !variable.optional).map(
  (variable) => variable.name,
);
const ALL_KEYS = ENV_VARS.map((variable) => variable.key);
const REQUIRED_KEYS = ENV_VARS.filter((variable) => !variable.optional).map(
  (variable) => variable.key,
);

let tempHome: string;
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "tempad-env-test-"));
  originalEnv = {};
  for (const name of [...ALL_ENV_NAMES, "TEMPAD_HOME"]) {
    originalEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.TEMPAD_HOME = tempHome;
});

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

function writeEnvFile(content: string): void {
  writeFileSync(join(tempHome, ".env"), content);
}

const VALID_ENV: Record<string, string> = {
  MONDAY_API_TOKEN: "token123",
  MONDAY_USER: "42",
  GH_USER: "octocat",
  GH_ORGS: "example-org",
  GH_INCLUDE_PERSONAL: "true",
  GIT_AUTHOR_EMAILS: "me@example.com",
  CLAUDE_DIRS: "~/.claude",
  HOST_SLUG: "laptop",
  TZ: "America/Sao_Paulo",
  SINCE: "2026-01-01",
};

function writeValidEnvWithOverride(name: string, value: string): void {
  const values = { ...VALID_ENV, [name]: value };
  writeEnvFile(
    Object.entries(values)
      .map(([key, val]) => `${key}=${val}`)
      .join("\n"),
  );
}

function configErrorFor(command: string, needs: readonly ConfigKey[]): ConfigError {
  try {
    loadConfig(command, needs);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected loadConfig to throw");
}

describe("ENV_VARS", () => {
  test("lists each environment variable and Config key exactly once", () => {
    expect(new Set(ALL_ENV_NAMES).size).toBe(ALL_ENV_NAMES.length);
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
    expect(ENV_VARS).toHaveLength(11);
  });

  test("every entry has a description and a known kind", () => {
    for (const variable of ENV_VARS) {
      expect(variable.description.length).toBeGreaterThan(0);
      expect(["string", "list", "boolean"]).toContain(variable.kind);
    }
  });

  test("marks the tokens secret and GH_TOKEN as the only optional variable", () => {
    const secrets = ENV_VARS.filter((variable) => variable.secret).map((variable) => variable.name);
    expect(secrets).toEqual(["MONDAY_API_TOKEN", "GH_TOKEN"]);
    expect(ENV_VARS.filter((variable) => variable.optional).map((v) => v.name)).toEqual([
      "GH_TOKEN",
    ]);
  });

  test("list and boolean kinds match how the values are parsed", () => {
    const kinds = Object.fromEntries(ENV_VARS.map((variable) => [variable.name, variable.kind]));
    expect(kinds.GH_ORGS).toBe("list");
    expect(kinds.GIT_AUTHOR_EMAILS).toBe("list");
    expect(kinds.CLAUDE_DIRS).toBe("list");
    expect(kinds.GH_INCLUDE_PERSONAL).toBe("boolean");
  });
});

describe("tempadHome / isConfigured / readDotEnv", () => {
  test("TEMPAD_HOME wins and expands ~", () => {
    process.env.TEMPAD_HOME = "~/somewhere-tempad";
    expect(tempadHome()).toBe(join(homedir(), "somewhere-tempad"));
    process.env.TEMPAD_HOME = tempHome;
    expect(tempadHome()).toBe(tempHome);
  });

  test("expands a bare ~ and ~/..., but not ~name or a ~ in the middle", () => {
    process.env.TEMPAD_HOME = "~";
    expect(tempadHome()).toBe(homedir());
    process.env.TEMPAD_HOME = "~/.tempad-work";
    expect(tempadHome()).toBe(join(homedir(), ".tempad-work"));
    process.env.TEMPAD_HOME = "~other/x";
    expect(tempadHome()).toBe("~other/x");
    process.env.TEMPAD_HOME = "/a/~/b";
    expect(tempadHome()).toBe("/a/~/b");
  });

  test("defaults to ~/.tempad when TEMPAD_HOME is unset or empty", () => {
    delete process.env.TEMPAD_HOME;
    expect(tempadHome()).toBe(join(homedir(), ".tempad"));
    process.env.TEMPAD_HOME = "";
    expect(tempadHome()).toBe(join(homedir(), ".tempad"));
  });

  test("isConfigured is false for an empty or missing home", () => {
    expect(isConfigured(tempHome)).toBe(false);
    expect(isConfigured(join(tempHome, "does-not-exist"))).toBe(false);
  });

  test("isConfigured is true with only .env", () => {
    writeFileSync(join(tempHome, ".env"), "");
    expect(isConfigured(tempHome)).toBe(true);
  });

  test("isConfigured is true with only tempad.db", () => {
    writeFileSync(join(tempHome, "tempad.db"), "");
    expect(isConfigured(tempHome)).toBe(true);
  });

  test("isConfigured ignores other files such as tempad.toml and logs", () => {
    writeFileSync(join(tempHome, "tempad.toml"), "");
    mkdirSync(join(tempHome, "logs"));
    expect(isConfigured(tempHome)).toBe(false);
  });

  test("readDotEnv parses comments, quotes and blank lines; a missing file is empty", () => {
    expect(readDotEnv(join(tempHome, "nope"))).toEqual({});
    writeEnvFile(
      ["# comment", "", 'A="quoted value"', "B='single'", "C = spaced ", "noequals"].join("\n"),
    );
    expect(readDotEnv(tempHome)).toEqual({ A: "quoted value", B: "single", C: "spaced" });
  });

  test("parseDotEnv keeps everything after the first = in the value", () => {
    expect(parseDotEnv("URL=a=b=c")).toEqual({ URL: "a=b=c" });
  });
});

describe("loadConfig", () => {
  test("requests nothing: returns only the home, reads no variable", () => {
    expect(loadConfig("tempad stint list", [])).toEqual({ home: tempHome });
  });

  test("validates only the requested variables, with an otherwise empty environment", () => {
    writeEnvFile("TZ=Europe/Berlin");
    const config = loadConfig("tempad report daily", ["tz"]);
    expect(config).toEqual({ tz: "Europe/Berlin", home: tempHome });
  });

  test("returns only the requested fields, not the whole config", () => {
    writeValidEnvWithOverride("TZ", "UTC");
    const config = loadConfig("tempad report daily", ["tz"]);
    expect(Object.keys(config).sort()).toEqual(["home", "tz"]);
  });

  test("an unrequested variable that is invalid or missing never throws", () => {
    writeEnvFile("TZ=UTC\nGH_INCLUDE_PERSONAL=yes\nGH_ORGS=");
    expect(loadConfig("tempad report daily", ["tz"]).tz).toBe("UTC");
  });

  test("throws one ConfigError naming the command and every missing variable", () => {
    writeEnvFile("");
    const error = configErrorFor("tempad sync monday", ["mondayApiToken", "mondayUser"]);
    expect(error.message).toBe(
      `tempad sync monday needs MONDAY_API_TOKEN, MONDAY_USER; set them in ${join(tempHome, ".env")} or run: bunx tempad init`,
    );
    expect(error.command).toBe("tempad sync monday");
    expect(error.variables).toEqual(["MONDAY_API_TOKEN", "MONDAY_USER"]);
    expect(error.name).toBe("ConfigError");
  });

  test("a single missing variable reads naturally", () => {
    writeEnvFile("");
    const error = configErrorFor("tempad report daily", ["tz"]);
    expect(error.message).toBe(
      `tempad report daily needs TZ; set it in ${join(tempHome, ".env")} or run: bunx tempad init`,
    );
  });

  test("lists every required variable when all are requested, never GH_TOKEN", () => {
    writeEnvFile("");
    const error = configErrorFor("tempad sync", ALL_KEYS);
    for (const name of REQUIRED_ENV_NAMES) expect(error.message).toContain(name);
    expect(error.message).not.toContain("GH_TOKEN");
    expect(error.variables).toEqual(REQUIRED_ENV_NAMES);
  });

  test("lists only the variables that are actually missing", () => {
    writeEnvFile("MONDAY_API_TOKEN=abc");
    const error = configErrorFor("tempad sync monday", ["mondayApiToken", "mondayUser"]);
    expect(error.variables).toEqual(["MONDAY_USER"]);
    expect(error.message).not.toContain("MONDAY_API_TOKEN");
  });

  test("the error points at the resolved TEMPAD_HOME, not a hard-coded path", () => {
    const error = configErrorFor("tempad report daily", ["tz"]);
    expect(error.message).toContain(join(tempHome, ".env"));
  });

  test("has no default for any required variable (TZ, SINCE, HOST_SLUG all throw when absent)", () => {
    for (const key of REQUIRED_KEYS) {
      expect(() => loadConfig("tempad probe", [key])).toThrow(ConfigError);
    }
  });

  test("happy path parses lists, booleans, and home expansion", () => {
    writeEnvFile(
      [
        "MONDAY_API_TOKEN=token123",
        "MONDAY_USER=42",
        "GH_USER=octocat",
        "GH_ORGS=example-org, other-org",
        "GH_INCLUDE_PERSONAL=true",
        "GIT_AUTHOR_EMAILS=me@example.com, other@example.com",
        "CLAUDE_DIRS=~/.claude,~/.claude-work",
        "HOST_SLUG=laptop",
        "TZ=America/Sao_Paulo",
        "SINCE=2026-01-01",
      ].join("\n"),
    );

    const config = loadConfig("tempad sync", ALL_KEYS);

    expect(config.mondayApiToken).toBe("token123");
    expect(config.ghOrgs).toEqual(["example-org", "other-org"]);
    expect(config.ghIncludePersonal).toBe(true);
    expect(config.gitAuthorEmails).toEqual(["me@example.com", "other@example.com"]);
    expect(config.claudeDirs).toEqual([
      join(homedir(), ".claude"),
      join(homedir(), ".claude-work"),
    ]);
    expect(config.ghToken).toBeUndefined();
    expect(config.home).toBe(tempHome);
  });

  test("GH_INCLUDE_PERSONAL=false parses to false", () => {
    writeValidEnvWithOverride("GH_INCLUDE_PERSONAL", "false");
    expect(loadConfig("tempad sync github", ["ghIncludePersonal"]).ghIncludePersonal).toBe(false);
  });

  test("bad boolean throws a ConfigError naming the command and variable", () => {
    for (const bad of ["yes", "True", "1", "TRUE"]) {
      writeValidEnvWithOverride("GH_INCLUDE_PERSONAL", bad);
      const error = configErrorFor("tempad sync github", ["ghIncludePersonal"]);
      expect(error.message).toContain("tempad sync github");
      expect(error.message).toContain("GH_INCLUDE_PERSONAL");
      expect(error.message).toContain(`"${bad}"`);
    }
  });

  test("empty value on a required var counts as missing", () => {
    writeValidEnvWithOverride("MONDAY_API_TOKEN", "");
    const error = configErrorFor("tempad sync", ALL_KEYS);
    expect(error.variables).toEqual(["MONDAY_API_TOKEN"]);
  });

  test("whitespace-only value on a required var counts as missing", () => {
    writeValidEnvWithOverride("HOST_SLUG", "   ");
    expect(configErrorFor("tempad sync", ALL_KEYS).variables).toEqual(["HOST_SLUG"]);
  });

  test("empty comma list counts as missing", () => {
    writeValidEnvWithOverride("GH_ORGS", "");
    expect(configErrorFor("tempad sync", ALL_KEYS).variables).toEqual(["GH_ORGS"]);
  });

  test("comma list of only commas/whitespace counts as missing", () => {
    writeValidEnvWithOverride("CLAUDE_DIRS", " , ,");
    expect(configErrorFor("tempad sync", ALL_KEYS).variables).toEqual(["CLAUDE_DIRS"]);
  });

  test("GH_TOKEN is optional: absent does not throw, empty is kept as empty", () => {
    writeValidEnvWithOverride("GH_TOKEN", "");
    expect(loadConfig("tempad sync github", ["ghToken"]).ghToken).toBe("");
    rmSync(join(tempHome, ".env"));
    expect(loadConfig("tempad sync github", ["ghToken"]).ghToken).toBeUndefined();
  });

  test("GH_TOKEN is read when set", () => {
    writeValidEnvWithOverride("GH_TOKEN", "ghp_example");
    expect(loadConfig("tempad sync github", ["ghToken"]).ghToken).toBe("ghp_example");
  });

  test("process.env wins over TEMPAD_HOME/.env", () => {
    writeEnvFile("TZ=America/Sao_Paulo\nHOST_SLUG=from-file");
    process.env.TZ = "Asia/Tokyo";
    try {
      const config = loadConfig("tempad probe", ["tz", "hostSlug"]);
      expect(config.tz).toBe("Asia/Tokyo");
      expect(config.hostSlug).toBe("from-file");
    } finally {
      delete process.env.TZ;
    }
  });

  test("process.env alone is enough: no .env file needed", () => {
    process.env.SINCE = "2026-02-02";
    try {
      expect(loadConfig("tempad probe", ["since"]).since).toBe("2026-02-02");
    } finally {
      delete process.env.SINCE;
    }
  });

  test("a .env in the current directory is not read by loadConfig itself", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tempad-env-cwd-"));
    const previous = process.cwd();
    try {
      writeFileSync(join(cwd, ".env"), "SINCE=1999-01-01");
      process.chdir(cwd);
      expect(() => loadConfig("tempad probe", ["since"])).toThrow(ConfigError);
    } finally {
      process.chdir(previous);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("requireFields", () => {
  test("returns the config when every field is present", () => {
    const config = { home: "/h", tz: "UTC" };
    expect(requireFields("tempad w5 eval", config, ["tz"])).toBe(config);
  });

  test("throws a plain Error when a dispatcher forgot to request a field", () => {
    expect(() => requireFields("tempad w5 eval", { home: "/h" }, ["tz"])).toThrow(/tz/);
  });
});

describe("ignoreWorkingDirectoryEnvFiles", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "tempad-env-cwd-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("removes values Bun loaded from cwd .env", () => {
    writeFileSync(join(cwd, ".env"), "TZ=UTC\nSINCE=2020-01-01\n");
    const environment: NodeJS.ProcessEnv = { TZ: "UTC", SINCE: "2020-01-01", PATH: "/usr/bin" };
    ignoreWorkingDirectoryEnvFiles(cwd, environment, []);
    expect(environment).toEqual({ PATH: "/usr/bin" });
  });

  test("covers .env.local and the NODE_ENV-specific files", () => {
    writeFileSync(join(cwd, ".env.local"), "TZ=UTC");
    writeFileSync(join(cwd, ".env.development"), "HOST_SLUG=ci");
    const environment: NodeJS.ProcessEnv = { TZ: "UTC", HOST_SLUG: "ci" };
    ignoreWorkingDirectoryEnvFiles(cwd, environment, []);
    expect(environment).toEqual({});
  });

  test("keeps a value the caller set differently from the cwd file", () => {
    writeFileSync(join(cwd, ".env"), "TZ=UTC");
    const environment: NodeJS.ProcessEnv = { TZ: "Asia/Tokyo" };
    ignoreWorkingDirectoryEnvFiles(cwd, environment, []);
    expect(environment.TZ).toBe("Asia/Tokyo");
  });

  test("leaves variables tempad does not read alone", () => {
    writeFileSync(join(cwd, ".env"), "DATABASE_URL=postgres://x\nTZ=UTC");
    const environment: NodeJS.ProcessEnv = { DATABASE_URL: "postgres://x", TZ: "UTC" };
    ignoreWorkingDirectoryEnvFiles(cwd, environment, []);
    expect(environment).toEqual({ DATABASE_URL: "postgres://x" });
  });

  test("also strips TEMPAD_HOME and ANTHROPIC_API_KEY injected by a project .env", () => {
    writeFileSync(join(cwd, ".env"), "TEMPAD_HOME=/evil\nANTHROPIC_API_KEY=sk-project");
    const environment: NodeJS.ProcessEnv = {
      TEMPAD_HOME: "/evil",
      ANTHROPIC_API_KEY: "sk-project",
    };
    ignoreWorkingDirectoryEnvFiles(cwd, environment, []);
    expect(environment).toEqual({});
  });

  test("does nothing when the process already runs with --no-env-file", () => {
    writeFileSync(join(cwd, ".env"), "TZ=UTC");
    const environment: NodeJS.ProcessEnv = { TZ: "UTC" };
    ignoreWorkingDirectoryEnvFiles(cwd, environment, ["--no-env-file"]);
    expect(environment.TZ).toBe("UTC");
  });

  test("a directory with no .env files is a no-op", () => {
    const environment: NodeJS.ProcessEnv = { TZ: "UTC" };
    ignoreWorkingDirectoryEnvFiles(cwd, environment, []);
    expect(environment.TZ).toBe("UTC");
  });
});

describe("anthropicApiKey", () => {
  let previousKey: string | undefined;
  beforeEach(() => {
    previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });

  test("has no default: undefined with neither the environment nor TEMPAD_HOME/.env", () => {
    expect(anthropicApiKey(tempHome)).toBeUndefined();
    writeEnvFile("MONDAY_USER=1\n");
    expect(anthropicApiKey(tempHome)).toBeUndefined();
  });

  test("falls back to TEMPAD_HOME/.env, unquoting the value", () => {
    writeEnvFile('ANTHROPIC_API_KEY="sk-from-file"\n');
    expect(anthropicApiKey(tempHome)).toBe("sk-from-file");
  });

  test("the real environment wins over the file; an empty value counts as unset", () => {
    writeEnvFile("ANTHROPIC_API_KEY=sk-from-file\n");
    process.env.ANTHROPIC_API_KEY = "sk-from-env";
    expect(anthropicApiKey(tempHome)).toBe("sk-from-env");
    process.env.ANTHROPIC_API_KEY = "";
    expect(anthropicApiKey(tempHome)).toBe("sk-from-file");
    writeEnvFile("ANTHROPIC_API_KEY=\n");
    expect(anthropicApiKey(tempHome)).toBeUndefined();
  });
});
