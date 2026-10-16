import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ENV_VARS, loadConfig, parseDotEnv } from "../src/config/env.ts";
import { loadRules } from "../src/config/rules.ts";
import { flagNameFor, formatEnvValue, renderEnvFile } from "../src/init/env-file.ts";
import { type InitDeps, runInit } from "../src/init/index.ts";
import { createPrompter, InputAborted, InputEnded } from "../src/init/prompt.ts";
import { renderTomlFile } from "../src/init/toml-file.ts";
import {
  isValidSince,
  isValidTimeZone,
  type SpawnFunction,
  type SpawnResult,
} from "../src/init/validate.ts";
import { defaultIntentConfig, loadIntentConfig } from "../src/intent/config.ts";
import { installHooks } from "../src/w5/hooks.ts";

const MONDAY_TOKEN = "monday-secret-token-0123456789";
const GITHUB_TOKEN = "ghp_secretgithubtoken0123456789";

const VALID: Record<string, string> = {
  MONDAY_API_TOKEN: MONDAY_TOKEN,
  MONDAY_USER: "Jane Doe",
  GH_USER: "jane",
  GH_ORGS: "acme,other-org",
  GH_INCLUDE_PERSONAL: "true",
  GIT_AUTHOR_EMAILS: "jane@example.com,jane@work.example",
  CLAUDE_DIRS: "~/.claude",
  HOST_SLUG: "laptop",
  TZ: "Europe/Berlin",
  SINCE: "2026-01-01",
};

let root: string;
let fakeHome: string;
let tempadHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tempad-init-test-"));
  fakeHome = join(root, "home");
  tempadHome = join(root, "tempad-home");
  mkdirSync(join(fakeHome, ".claude", "projects"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** `--flag value` pairs for the given values, derived from ENV_VARS like the command does. */
function flagsFor(values: Record<string, string>): string[] {
  return ENV_VARS.flatMap((variable) =>
    values[variable.name] === undefined
      ? []
      : [`--${flagNameFor(variable)}`, values[variable.name] as string],
  );
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

function jsonResponse(status: number, body: unknown): FetchResponse {
  return new Response(JSON.stringify(body), { status }) as unknown as FetchResponse;
}

interface Harness {
  deps: Partial<InitDeps>;
  stdout: () => string;
  stderr: () => string;
  everything: () => string;
  fetchCalls: { url: string; init: RequestInit | undefined }[];
  spawnCalls: string[][];
  run: (args: string[]) => Promise<number>;
}

interface HarnessOptions {
  fetchImpl?: (
    url: string,
    init: RequestInit | undefined,
  ) => FetchResponse | Promise<FetchResponse>;
  spawnResults?: Record<string, SpawnResult | "missing">;
  env?: Record<string, string>;
  input?: string;
  isTTY?: boolean;
}

const mondayOk = (): FetchResponse =>
  jsonResponse(200, { data: { me: { id: 42, name: "Jane Doe" } } });

function harness(options: HarnessOptions = {}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetchCalls: Harness["fetchCalls"] = [];
  const spawnCalls: string[][] = [];

  const fetchFake = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<FetchResponse> => {
    fetchCalls.push({ url: String(url), init });
    if (!options.fetchImpl) throw new Error("unexpected network access in a test");
    return options.fetchImpl(String(url), init);
  };
  const spawn: SpawnFunction = async (command) => {
    spawnCalls.push(command);
    const result = options.spawnResults?.[command.join(" ")];
    if (result === undefined || result === "missing") throw new Error("ENOENT");
    return result;
  };

  const stdin = new PassThrough();
  if (options.input !== undefined) {
    stdin.write(options.input);
    stdin.end();
  }

  const deps: Partial<InitDeps> = {
    env: options.env ?? {},
    homedir: fakeHome,
    stdin,
    isTTY: options.isTTY ?? false,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    fetch: fetchFake as unknown as typeof fetch,
    spawn,
    hostname: () => "My-Laptop.local",
    timeZone: () => "Europe/Berlin",
    timeoutMs: 200,
    detectTimeoutMs: 200,
  };
  return {
    deps,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    everything: () => stdout.join("") + stderr.join(""),
    fetchCalls,
    spawnCalls,
    run: (args) => runInit(args, deps),
  };
}

const NON_INTERACTIVE = ["--non-interactive", "--home"];

function nonInteractive(values: Record<string, string>, extra: string[] = []): string[] {
  return [...NON_INTERACTIVE, tempadHome, ...flagsFor(values), ...extra];
}

describe("flag names", () => {
  test("every variable has a distinct flag derived from its name", () => {
    const flags = ENV_VARS.map(flagNameFor);
    expect(new Set(flags).size).toBe(ENV_VARS.length);
    expect(flags).toContain("monday-api-token");
    expect(flags).toContain("gh-orgs");
    expect(flags).toContain("tz");
  });
});

describe("non-interactive", () => {
  test("writes .env (0600) and tempad.toml, creating the home with 0700", async () => {
    const h = harness();
    const code = await h.run(nonInteractive(VALID, ["--no-verify"]));
    expect(code).toBe(0);
    expect(statSync(join(tempadHome, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(tempadHome).mode & 0o777).toBe(0o700);
    expect(existsSync(join(tempadHome, "tempad.toml"))).toBe(true);
    expect(h.fetchCalls).toHaveLength(0);
  });

  test("what init writes, loadConfig reads back identically", async () => {
    const tricky = {
      ...VALID,
      MONDAY_USER: 'Jane "JD" Doe # intern',
      GH_TOKEN: GITHUB_TOKEN,
      HOST_SLUG: "it's-mine",
    };
    const h = harness();
    expect(await h.run(nonInteractive(tricky, ["--no-verify"]))).toBe(0);

    const saved = { ...process.env };
    try {
      for (const variable of ENV_VARS) delete process.env[variable.name];
      process.env.TEMPAD_HOME = tempadHome;
      const config = loadConfig(
        "test",
        ENV_VARS.map((variable) => variable.key),
      );
      expect(config.mondayApiToken).toBe(MONDAY_TOKEN);
      expect(config.mondayUser).toBe('Jane "JD" Doe # intern');
      expect(config.ghUser).toBe("jane");
      expect(config.ghOrgs).toEqual(["acme", "other-org"]);
      expect(config.ghIncludePersonal).toBe(true);
      expect(config.ghToken).toBe(GITHUB_TOKEN);
      expect(config.gitAuthorEmails).toEqual(["jane@example.com", "jane@work.example"]);
      expect(config.claudeDirs).toEqual([join(homedir(), ".claude")]);
      expect(config.hostSlug).toBe("it's-mine");
      expect(config.tz).toBe("Europe/Berlin");
      expect(config.since).toBe("2026-01-01");
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  test("an unset optional variable is written commented out and reads back as unset", async () => {
    const h = harness();
    expect(await h.run(nonInteractive(VALID, ["--no-verify"]))).toBe(0);
    const text = readFileSync(join(tempadHome, ".env"), "utf8");
    expect(text).toContain("# GH_TOKEN=");
    expect(parseDotEnv(text).GH_TOKEN).toBeUndefined();
  });

  test("values may come from the environment; a flag wins over it", async () => {
    const h = harness({ env: { ...VALID, HOST_SLUG: "from-env", TZ: "UTC" } });
    const flags = flagsFor({ HOST_SLUG: "from-flag" });
    const code = await h.run([...NON_INTERACTIVE, tempadHome, "--no-verify", ...flags]);
    expect(code).toBe(0);
    const written = parseDotEnv(readFileSync(join(tempadHome, ".env"), "utf8"));
    expect(written.HOST_SLUG).toBe("from-flag");
    expect(written.TZ).toBe("UTC");
    expect(written.MONDAY_API_TOKEN).toBe(MONDAY_TOKEN);
  });

  test("TEMPAD_HOME from the environment is the default home; --home wins", async () => {
    const fromEnv = join(root, "from-env");
    const h = harness({ env: { TEMPAD_HOME: fromEnv } });
    expect(await h.run(["--non-interactive", "--no-verify", ...flagsFor(VALID)])).toBe(0);
    expect(existsSync(join(fromEnv, ".env"))).toBe(true);
    expect(existsSync(tempadHome)).toBe(false);
  });

  test("normalizes lists and booleans", async () => {
    const h = harness();
    const code = await h.run(
      nonInteractive({ ...VALID, GH_ORGS: " acme , ,other ", GH_INCLUDE_PERSONAL: "TRUE" }, [
        "--no-verify",
      ]),
    );
    expect(code).toBe(0);
    const written = parseDotEnv(readFileSync(join(tempadHome, ".env"), "utf8"));
    expect(written.GH_ORGS).toBe("acme,other");
    expect(written.GH_INCLUDE_PERSONAL).toBe("true");
  });

  test("a missing required value exits 1 naming every missing variable and its flag", async () => {
    const h = harness();
    const { MONDAY_API_TOKEN: _token, TZ: _tz, ...partial } = VALID;
    const code = await h.run(nonInteractive(partial, ["--no-verify"]));
    expect(code).toBe(1);
    expect(h.stderr()).toContain("MONDAY_API_TOKEN (--monday-api-token)");
    expect(h.stderr()).toContain("TZ (--tz)");
    expect(h.stderr()).not.toContain("GH_TOKEN");
    expect(existsSync(join(tempadHome, ".env"))).toBe(false);
  });

  test("nothing at all names all ten required variables; GH_TOKEN stays optional", async () => {
    const h = harness();
    const code = await h.run([...NON_INTERACTIVE, tempadHome]);
    expect(code).toBe(1);
    for (const variable of ENV_VARS.filter((candidate) => !candidate.optional)) {
      expect(h.stderr()).toContain(`${variable.name} (--${flagNameFor(variable)})`);
    }
    expect(h.stderr()).not.toContain("--gh-token");
  });

  test("an empty or whitespace-only flag counts as missing", async () => {
    const h = harness();
    const code = await h.run(nonInteractive({ ...VALID, HOST_SLUG: "   " }, ["--no-verify"]));
    expect(code).toBe(1);
    expect(h.stderr()).toContain("HOST_SLUG (--host-slug)");
  });

  test("an unknown flag is a usage error (exit 2)", async () => {
    const h = harness();
    expect(await h.run(["--non-interactive", "--bogus", "x"])).toBe(2);
    expect(h.stderr()).toContain("usage: tempad init");
  });

  test("without --non-interactive and without a terminal it fails instead of hanging", async () => {
    const h = harness({ isTTY: false });
    const code = await h.run(["--home", tempadHome]);
    expect(code).toBe(1);
    expect(h.stderr()).toContain("--non-interactive");
    expect(existsSync(tempadHome)).toBe(false);
  });
});

describe("existing files", () => {
  async function seed(): Promise<void> {
    mkdirSync(tempadHome, { recursive: true });
    writeFileSync(join(tempadHome, ".env"), "TZ=Asia/Tokyo\n");
    writeFileSync(join(tempadHome, "tempad.toml"), '[hero]\nname = "Hand Edited"\n');
  }

  test("non-interactive without --force refuses, exits 1 and changes nothing", async () => {
    await seed();
    const h = harness();
    const code = await h.run(nonInteractive(VALID, ["--no-verify"]));
    expect(code).toBe(1);
    expect(h.stderr()).toContain("--force");
    expect(readFileSync(join(tempadHome, ".env"), "utf8")).toBe("TZ=Asia/Tokyo\n");
    expect(readFileSync(join(tempadHome, "tempad.toml"), "utf8")).toContain("Hand Edited");
  });

  test("--force replaces both files and keeps backups", async () => {
    await seed();
    const h = harness();
    const code = await h.run(nonInteractive(VALID, ["--no-verify", "--force"]));
    expect(code).toBe(0);
    expect(parseDotEnv(readFileSync(join(tempadHome, ".env"), "utf8")).TZ).toBe("Europe/Berlin");
    expect(readFileSync(join(tempadHome, "tempad.toml"), "utf8")).not.toContain("Hand Edited");
    expect(readFileSync(join(tempadHome, ".env.bak"), "utf8")).toBe("TZ=Asia/Tokyo\n");
    expect(statSync(join(tempadHome, ".env.bak")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(tempadHome, "tempad.toml.bak"), "utf8")).toContain("Hand Edited");
    expect(statSync(join(tempadHome, ".env")).mode & 0o777).toBe(0o600);
  });

  test("an existing tempad.toml is kept when only .env is missing", async () => {
    mkdirSync(tempadHome, { recursive: true });
    writeFileSync(join(tempadHome, "tempad.toml"), '[hero]\nname = "Hand Edited"\n');
    const h = harness();
    expect(await h.run(nonInteractive(VALID, ["--no-verify"]))).toBe(0);
    expect(readFileSync(join(tempadHome, "tempad.toml"), "utf8")).toContain("Hand Edited");
    expect(h.stdout()).toContain("Kept the existing");
    expect(existsSync(join(tempadHome, ".env"))).toBe(true);
  });

  test("--force tightens the mode of a world-readable .env", async () => {
    await seed();
    chmodSync(join(tempadHome, ".env"), 0o644);
    const h = harness();
    expect(await h.run(nonInteractive(VALID, ["--no-verify", "--force"]))).toBe(0);
    expect(statSync(join(tempadHome, ".env")).mode & 0o777).toBe(0o600);
  });
});

describe("validation (injected fetch and spawn)", () => {
  const ghLoggedIn = { "gh auth status": { exitCode: 0, stdout: "", timedOut: false } } as const;

  test("Monday ok: reports the user's name, checks the right request, exits 0", async () => {
    const h = harness({
      fetchImpl: () => mondayOk(),
      spawnResults: { ...ghLoggedIn },
    });
    const code = await h.run(nonInteractive(VALID));
    expect(code).toBe(0);
    expect(h.stdout()).toContain("Monday: authenticated as Jane Doe");
    const call = h.fetchCalls[0];
    expect(call?.url).toBe("https://api.monday.com/v2");
    expect(call?.init?.method).toBe("POST");
    expect((call?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      MONDAY_TOKEN,
    );
    expect(String(call?.init?.body)).toContain("me { id name }");
    expect(h.stdout()).toContain("using the logged-in gh credentials");
  });

  test("a MONDAY_USER that is neither the id nor the name only warns", async () => {
    const h = harness({
      fetchImpl: () => mondayOk(),
      spawnResults: { ...ghLoggedIn },
    });
    const code = await h.run(nonInteractive({ ...VALID, MONDAY_USER: "someone else" }));
    expect(code).toBe(0);
    expect(h.stdout()).toContain("warning: MONDAY_USER");
  });

  test("MONDAY_USER may be the numeric id", async () => {
    const h = harness({
      fetchImpl: () => mondayOk(),
      spawnResults: { ...ghLoggedIn },
    });
    const code = await h.run(nonInteractive({ ...VALID, MONDAY_USER: "42" }));
    expect(code).toBe(0);
    expect(h.stdout()).not.toContain("warning");
  });

  test("Monday 401 is an error: exit 1, nothing written, token never printed", async () => {
    const h = harness({
      fetchImpl: () => jsonResponse(401, { error: `bad token ${MONDAY_TOKEN}` }),
      spawnResults: { ...ghLoggedIn },
    });
    const code = await h.run(nonInteractive(VALID));
    expect(code).toBe(1);
    expect(h.everything()).toContain("Monday rejected the token (HTTP 401)");
    expect(h.everything()).not.toContain(MONDAY_TOKEN);
    expect(existsSync(join(tempadHome, ".env"))).toBe(false);
  });

  test("a network failure is an error in non-interactive mode, and never leaks the token", async () => {
    const h = harness({
      fetchImpl: () => {
        throw new Error(`connect ECONNREFUSED while sending ${MONDAY_TOKEN}`);
      },
      spawnResults: { ...ghLoggedIn },
    });
    const code = await h.run(nonInteractive(VALID));
    expect(code).toBe(1);
    expect(h.stdout()).toContain("not verified");
    expect(h.everything()).not.toContain(MONDAY_TOKEN);
    expect(existsSync(join(tempadHome, ".env"))).toBe(false);
  });

  test("--no-verify writes despite a failing network and makes no call at all", async () => {
    const h = harness({
      fetchImpl: () => {
        throw new Error("offline");
      },
    });
    expect(await h.run(nonInteractive(VALID, ["--no-verify"]))).toBe(0);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.spawnCalls).toHaveLength(0);
  });

  test("gh missing and no GH_TOKEN is an error", async () => {
    const h = harness({
      fetchImpl: () => mondayOk(),
      spawnResults: { "gh auth status": "missing" },
    });
    const code = await h.run(nonInteractive(VALID));
    expect(code).toBe(1);
    expect(h.everything()).toContain("gh is not installed");
  });

  test("gh installed but logged out is an error", async () => {
    const h = harness({
      fetchImpl: () => mondayOk(),
      spawnResults: { "gh auth status": { exitCode: 1, stdout: "", timedOut: false } },
    });
    expect(await h.run(nonInteractive(VALID))).toBe(1);
    expect(h.everything()).toContain("gh is not logged in");
  });

  test("a gh that hangs is unverified, not a crash", async () => {
    const h = harness({
      fetchImpl: () => mondayOk(),
      spawnResults: { "gh auth status": { exitCode: 1, stdout: "", timedOut: true } },
    });
    expect(await h.run(nonInteractive(VALID))).toBe(1);
    expect(h.everything()).toContain("did not answer in time");
  });

  test("with GH_TOKEN, GitHub is checked through /user and gh is not consulted", async () => {
    const h = harness({
      fetchImpl: (url) =>
        url.includes("monday") ? mondayOk() : jsonResponse(200, { login: "jane" }),
    });
    const code = await h.run(nonInteractive({ ...VALID, GH_TOKEN: GITHUB_TOKEN }));
    expect(code).toBe(0);
    const github = h.fetchCalls.find((call) => call.url === "https://api.github.com/user");
    expect((github?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      `Bearer ${GITHUB_TOKEN}`,
    );
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.stdout()).toContain("token belongs to jane");
    expect(h.everything()).not.toContain(GITHUB_TOKEN);
  });

  test("GitHub rejecting GH_TOKEN is an error and the token stays out of the output", async () => {
    const h = harness({
      fetchImpl: (url) =>
        url.includes("monday")
          ? mondayOk()
          : jsonResponse(401, { message: `Bad credentials ${GITHUB_TOKEN}` }),
    });
    const code = await h.run(nonInteractive({ ...VALID, GH_TOKEN: GITHUB_TOKEN }));
    expect(code).toBe(1);
    expect(h.everything()).toContain("GitHub rejected GH_TOKEN (HTTP 401)");
    expect(h.everything()).not.toContain(GITHUB_TOKEN);
    expect(h.everything()).not.toContain(MONDAY_TOKEN);
  });

  test("a CLAUDE_DIRS entry that does not exist is an error", async () => {
    const h = harness({
      fetchImpl: () => mondayOk(),
      spawnResults: { ...ghLoggedIn },
    });
    const code = await h.run(nonInteractive({ ...VALID, CLAUDE_DIRS: "~/.claude,~/missing-dir" }));
    expect(code).toBe(1);
    expect(h.everything()).toContain("~/missing-dir is not an existing directory");
  });

  test("a CLAUDE_DIRS entry without projects/ only warns", async () => {
    mkdirSync(join(fakeHome, "bare"), { recursive: true });
    const h = harness({
      fetchImpl: () => mondayOk(),
      spawnResults: { ...ghLoggedIn },
    });
    const code = await h.run(nonInteractive({ ...VALID, CLAUDE_DIRS: "~/bare" }));
    expect(code).toBe(0);
    expect(h.stdout()).toContain("has no projects/ folder");
  });

  test("a hang in fetch is cut off by the time box", async () => {
    const h = harness({
      fetchImpl: (_url, init) =>
        new Promise<FetchResponse>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
          );
        }),
      spawnResults: { ...ghLoggedIn },
    });
    const started = Date.now();
    const code = await h.run(nonInteractive(VALID));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(code).toBe(1);
    expect(h.stdout()).toContain("did not answer in time");
  });
});

describe("value checks", () => {
  test.each([
    ["TZ", "Mars/Olympus", "not an IANA time zone"],
    ["SINCE", "yesterday", "not a date"],
    ["SINCE", "2026-02-30", "not a date"],
    ["GH_INCLUDE_PERSONAL", "yes", '"true" or "false"'],
  ])("%s=%p is rejected (%s), even with --no-verify", async (name, value, message) => {
    const h = harness();
    const code = await h.run(nonInteractive({ ...VALID, [name]: value }, ["--no-verify"]));
    expect(code).toBe(1);
    expect(h.stderr()).toContain(name);
    expect(h.stderr()).toContain(message);
    expect(existsSync(join(tempadHome, ".env"))).toBe(false);
  });

  test("a list with no entries counts as missing", async () => {
    const h = harness();
    const code = await h.run(
      nonInteractive({ ...VALID, GH_ORGS: " , ", GIT_AUTHOR_EMAILS: "," }, ["--no-verify"]),
    );
    expect(code).toBe(1);
    expect(h.stderr()).toContain("GH_ORGS (--gh-orgs)");
    expect(h.stderr()).toContain("GIT_AUTHOR_EMAILS (--git-author-emails)");
  });

  test("a value with a line break is refused", async () => {
    const h = harness();
    const code = await h.run(nonInteractive({ ...VALID, HOST_SLUG: "a\nb" }, ["--no-verify"]));
    expect(code).toBe(1);
    expect(h.stderr()).toContain("single line");
  });

  test("time zone and date helpers", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Atlantis")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidSince("2026-10-16")).toBe(true);
    expect(isValidSince("2026-1-5")).toBe(false);
    expect(isValidSince("2026-13-01")).toBe(false);
    expect(isValidSince("2026-10-16T00:00:00Z")).toBe(false);
  });
});

describe("env file format", () => {
  test("quoting round-trips through parseDotEnv", () => {
    const values = [
      "plain",
      "with space",
      "  padded  ",
      'say "hi"',
      "'single'",
      '"double"',
      "a#b",
      "$HOME/x",
      "back\\slash",
      "=leading-equals",
      '"',
    ];
    for (const value of values) {
      const parsed = parseDotEnv(`K=${formatEnvValue(value)}\n`);
      expect(parsed.K).toBe(value);
    }
  });

  test("a line break cannot be written", () => {
    expect(() => formatEnvValue("a\nb")).toThrow();
    expect(() => formatEnvValue("a\rb")).toThrow();
  });

  test("renderEnvFile lists every variable, carries extras, and is parseable", () => {
    const text = renderEnvFile(VALID, { ANTHROPIC_API_KEY: "sk-extra" });
    const parsed = parseDotEnv(text);
    for (const variable of ENV_VARS.filter((candidate) => !candidate.optional)) {
      expect(parsed[variable.name]).toBeDefined();
      expect(text).toContain(`# ${variable.description}`);
    }
    expect(parsed.ANTHROPIC_API_KEY).toBe("sk-extra");
  });
});

describe("tempad.toml", () => {
  test("the template parses and changes nothing while commented out", () => {
    const path = join(root, "t.toml");
    writeFileSync(path, renderTomlFile());
    expect(Bun.TOML.parse(renderTomlFile())).toEqual({});
    expect(loadIntentConfig(path)).toEqual(defaultIntentConfig());
  });

  test("uncommenting the [w5] block and the example rules yields valid, default-valued config", () => {
    const lines = renderTomlFile().split("\n");
    const uncommented = lines
      .map((line) => (/^# (\[|[a-z_]+ = )/.test(line) ? line.slice(2) : line))
      .join("\n");
    const path = join(root, "t.toml");
    writeFileSync(path, uncommented);
    expect(loadIntentConfig(path).w5).toEqual(defaultIntentConfig().w5);
    const rules = loadRules(path);
    expect(rules.projects).toHaveLength(2);
    expect(rules.projects[0]).toMatchObject({ kind: "path", org: "my-org", name: "My Project" });
  });
});

describe("secrets in output", () => {
  test("the summary shows set / not set for secrets and the values for the rest", async () => {
    const h = harness();
    expect(await h.run(nonInteractive(VALID, ["--no-verify"]))).toBe(0);
    const out = h.stdout();
    expect(out).toContain("MONDAY_API_TOKEN=set");
    expect(out).toContain("GH_TOKEN=not set");
    expect(out).toContain("MONDAY_USER=Jane Doe");
    expect(out).toContain("TZ=Europe/Berlin");
    expect(h.everything()).not.toContain(MONDAY_TOKEN);
  });

  test("a set GH_TOKEN shows as set; neither token appears anywhere", async () => {
    const h = harness();
    expect(await h.run(nonInteractive({ ...VALID, GH_TOKEN: GITHUB_TOKEN }, ["--no-verify"]))).toBe(
      0,
    );
    expect(h.stdout()).toContain("GH_TOKEN=set");
    expect(h.everything()).not.toContain(GITHUB_TOKEN);
    expect(h.everything()).not.toContain(MONDAY_TOKEN);
  });

  test("a secret supplied through the environment is redacted from any message", async () => {
    const h = harness({
      env: { MONDAY_API_TOKEN: MONDAY_TOKEN },
      fetchImpl: () => {
        throw new Error(`failed: ${MONDAY_TOKEN}`);
      },
      spawnResults: { "gh auth status": { exitCode: 0, stdout: "", timedOut: false } },
    });
    const { MONDAY_API_TOKEN: _omit, ...rest } = VALID;
    const code = await h.run(nonInteractive(rest));
    expect(code).toBe(1);
    expect(h.everything()).not.toContain(MONDAY_TOKEN);
  });
});

/** One answer line per variable, in ENV_VARS order; unlisted variables answer with Enter. */
function answers(given: Record<string, string>): string {
  return ENV_VARS.map((variable) => `${given[variable.name] ?? ""}\n`).join("");
}

const DETECTED = {
  "git config --global user.email": { exitCode: 0, stdout: "me@example.com\n", timedOut: false },
  "gh api user --jq .login": { exitCode: 0, stdout: "octocat\n", timedOut: false },
} as const;

describe("interactive wizard", () => {
  test("offers detected suggestions, accepts them with Enter, never echoes the secret", async () => {
    const h = harness({
      isTTY: true,
      spawnResults: { ...DETECTED },
      input: answers({
        MONDAY_API_TOKEN: MONDAY_TOKEN,
        MONDAY_USER: "Jane Doe",
        GH_ORGS: "acme",
        GH_INCLUDE_PERSONAL: "false",
        SINCE: "2026-03-01",
      }),
    });
    const code = await h.run(["--home", tempadHome, "--no-verify"]);
    expect(code).toBe(0);

    const out = h.stdout();
    expect(out).toContain("[Europe/Berlin]");
    expect(out).toContain("[my-laptop]");
    expect(out).toContain("[me@example.com]");
    expect(out).toContain("[octocat]");
    expect(out).toContain("[~/.claude]");
    expect(out).not.toContain("~/.claude/projects");
    // Visible answers are echoed; the secret is not, and its line shows nothing after the prompt.
    expect(out).toContain("Jane Doe");
    expect(out).not.toContain(MONDAY_TOKEN);
    expect(out).not.toContain("monday-sec");
    expect(out).toContain("MONDAY_API_TOKEN: \n");

    const written = parseDotEnv(readFileSync(join(tempadHome, ".env"), "utf8"));
    expect(written).toMatchObject({
      MONDAY_API_TOKEN: MONDAY_TOKEN,
      MONDAY_USER: "Jane Doe",
      GH_USER: "octocat",
      GH_ORGS: "acme",
      GH_INCLUDE_PERSONAL: "false",
      GIT_AUTHOR_EMAILS: "me@example.com",
      CLAUDE_DIRS: "~/.claude",
      HOST_SLUG: "my-laptop",
      TZ: "Europe/Berlin",
      SINCE: "2026-03-01",
    });
    expect(written.GH_TOKEN).toBeUndefined();
    expect(h.stderr()).toBe("");
  });

  test("Enter on a required variable with no suggestion asks again and writes nothing if input ends", async () => {
    // No git, no gh: MONDAY_USER has no suggestion, so the empty answer is refused.
    const h = harness({ isTTY: true, input: `${MONDAY_TOKEN}\n\n` });
    const code = await h.run(["--home", tempadHome, "--no-verify"]);
    expect(code).toBe(1);
    expect(h.stdout()).toContain("a value is required");
    expect(existsSync(join(tempadHome, ".env"))).toBe(false);
  });

  test("an invalid answer is explained and asked again", async () => {
    const input = answers({
      MONDAY_API_TOKEN: MONDAY_TOKEN,
      MONDAY_USER: "Jane",
      GH_USER: "jane",
      GH_ORGS: "acme",
      GH_INCLUDE_PERSONAL: "true",
      GIT_AUTHOR_EMAILS: "j@example.com",
      SINCE: "2026-01-01",
    });
    // Insert a bad time zone answer before the real (Enter) one.
    const lines = input.split("\n");
    const tzIndex = ENV_VARS.findIndex((variable) => variable.name === "TZ");
    lines.splice(tzIndex, 0, "Nowhere/Land");
    const h = harness({ isTTY: true, input: lines.join("\n") });
    const code = await h.run(["--home", tempadHome, "--no-verify"]);
    expect(code).toBe(0);
    expect(h.stdout()).toContain('"Nowhere/Land" is not an IANA time zone');
    expect(parseDotEnv(readFileSync(join(tempadHome, ".env"), "utf8")).TZ).toBe("Europe/Berlin");
  });

  test("backspace edits a hidden answer without echoing anything", async () => {
    const h = harness({
      isTTY: true,
      spawnResults: { ...DETECTED },
      input: answers({
        MONDAY_API_TOKEN: "abcX\x7fd-token",
        MONDAY_USER: "Jane",
        GH_ORGS: "acme",
        GH_INCLUDE_PERSONAL: "true",
        SINCE: "2026-01-01",
      }),
    });
    expect(await h.run(["--home", tempadHome, "--no-verify"])).toBe(0);
    expect(parseDotEnv(readFileSync(join(tempadHome, ".env"), "utf8")).MONDAY_API_TOKEN).toBe(
      "abcd-token",
    );
    expect(h.stdout()).not.toContain("abcd");
    expect(h.stdout()).not.toContain("\b");
  });

  test("Ctrl-C aborts with exit 130 and writes nothing", async () => {
    const h = harness({ isTTY: true, input: "tok\x03" });
    const code = await h.run(["--home", tempadHome, "--no-verify"]);
    expect(code).toBe(130);
    expect(existsSync(tempadHome)).toBe(false);
    expect(h.stderr()).toContain("nothing was written");
    expect(h.everything()).not.toContain("tok\n");
  });

  test("Ctrl-C at the last question still writes nothing", async () => {
    const lines = answers({
      MONDAY_API_TOKEN: MONDAY_TOKEN,
      MONDAY_USER: "Jane",
      GH_USER: "jane",
      GH_ORGS: "acme",
      GH_INCLUDE_PERSONAL: "true",
      GIT_AUTHOR_EMAILS: "j@example.com",
    });
    const h = harness({ isTTY: true, input: `${lines}\x03` });
    expect(await h.run(["--home", tempadHome, "--no-verify"])).toBe(130);
    expect(existsSync(tempadHome)).toBe(false);
  });

  test("input that ends early exits 1 and writes nothing", async () => {
    const h = harness({ isTTY: true, input: "tok\n" });
    expect(await h.run(["--home", tempadHome, "--no-verify"])).toBe(1);
    expect(h.stderr()).toContain("input ended");
    expect(existsSync(tempadHome)).toBe(false);
  });

  test("an optional variable can be given and then removed on a rerun", async () => {
    const first = harness({
      isTTY: true,
      spawnResults: { ...DETECTED },
      input: answers({
        MONDAY_API_TOKEN: MONDAY_TOKEN,
        MONDAY_USER: "Jane",
        GH_ORGS: "acme",
        GH_INCLUDE_PERSONAL: "true",
        GH_TOKEN: GITHUB_TOKEN,
        SINCE: "2026-01-01",
      }),
    });
    expect(await first.run(["--home", tempadHome, "--no-verify"])).toBe(0);
    expect(parseDotEnv(readFileSync(join(tempadHome, ".env"), "utf8")).GH_TOKEN).toBe(GITHUB_TOKEN);
    expect(first.everything()).not.toContain(GITHUB_TOKEN);

    const second = harness({
      isTTY: true,
      input: `y\n${answers({ GH_TOKEN: "-" })}`,
    });
    expect(await second.run(["--home", tempadHome, "--no-verify"])).toBe(0);
    expect(parseDotEnv(readFileSync(join(tempadHome, ".env"), "utf8")).GH_TOKEN).toBeUndefined();
  });

  describe("with an existing .env", () => {
    beforeEach(() => {
      mkdirSync(tempadHome, { recursive: true });
      writeFileSync(
        join(tempadHome, ".env"),
        `${Object.entries({ ...VALID, GH_TOKEN: GITHUB_TOKEN })
          .map(([name, value]) => `${name}=${formatEnvValue(value)}`)
          .join("\n")}\nANTHROPIC_API_KEY=sk-ant-keep-me\n`,
      );
    });

    test("asks before touching it; declining changes nothing", async () => {
      const before = readFileSync(join(tempadHome, ".env"), "utf8");
      const h = harness({ isTTY: true, input: "n\n" });
      expect(await h.run(["--home", tempadHome, "--no-verify"])).toBe(0);
      expect(h.stdout()).toContain("already exists. Update it?");
      expect(h.stdout()).toContain("Nothing changed.");
      expect(readFileSync(join(tempadHome, ".env"), "utf8")).toBe(before);
    });

    test("current values are the suggestions; secrets say keep current and are never printed", async () => {
      const h = harness({ isTTY: true, input: `y\n${answers({ HOST_SLUG: "renamed" })}` });
      expect(await h.run(["--home", tempadHome, "--no-verify"])).toBe(0);
      const out = h.stdout();
      expect(out).toContain("MONDAY_API_TOKEN (keep current)");
      expect(out).toContain("GH_TOKEN (keep current)");
      expect(out).toContain("[Jane Doe]");
      expect(out).toContain("[Europe/Berlin]");
      expect(h.everything()).not.toContain(MONDAY_TOKEN);
      expect(h.everything()).not.toContain(GITHUB_TOKEN);

      const written = parseDotEnv(readFileSync(join(tempadHome, ".env"), "utf8"));
      expect(written.MONDAY_API_TOKEN).toBe(MONDAY_TOKEN);
      expect(written.GH_TOKEN).toBe(GITHUB_TOKEN);
      expect(written.HOST_SLUG).toBe("renamed");
      expect(written.ANTHROPIC_API_KEY).toBe("sk-ant-keep-me");
      expect(statSync(join(tempadHome, ".env")).mode & 0o777).toBe(0o600);
    });

    test("--force skips the confirmation and drops lines tempad does not own", async () => {
      const h = harness({ isTTY: true, input: answers({}) });
      expect(await h.run(["--home", tempadHome, "--no-verify", "--force"])).toBe(0);
      expect(h.stdout()).not.toContain("Update it?");
      const written = parseDotEnv(readFileSync(join(tempadHome, ".env"), "utf8"));
      expect(written.ANTHROPIC_API_KEY).toBeUndefined();
      expect(written.MONDAY_API_TOKEN).toBe(MONDAY_TOKEN);
    });

    test("flags given in the wizard override the current value as the suggestion", async () => {
      const h = harness({ isTTY: true, input: `y\n${answers({})}` });
      expect(await h.run(["--home", tempadHome, "--no-verify", "--tz", "Asia/Tokyo"])).toBe(0);
      expect(parseDotEnv(readFileSync(join(tempadHome, ".env"), "utf8")).TZ).toBe("Asia/Tokyo");
    });
  });

  describe("validation inside the wizard", () => {
    const input = answers({
      MONDAY_API_TOKEN: MONDAY_TOKEN,
      MONDAY_USER: "Jane Doe",
      GH_USER: "jane",
      GH_ORGS: "acme",
      GH_INCLUDE_PERSONAL: "true",
      GIT_AUTHOR_EMAILS: "j@example.com",
      SINCE: "2026-01-01",
    });
    const ghOk = { "gh auth status": { exitCode: 0, stdout: "", timedOut: false } } as const;

    test("a network failure is a warning the user can accept", async () => {
      const h = harness({
        isTTY: true,
        input: `${input}y\n`,
        fetchImpl: () => {
          throw new Error("offline");
        },
        spawnResults: { ...ghOk },
      });
      const code = await h.run(["--home", tempadHome]);
      expect(code).toBe(0);
      expect(h.stdout()).toContain("Write the files anyway?");
      expect(existsSync(join(tempadHome, ".env"))).toBe(true);
      expect(h.everything()).not.toContain(MONDAY_TOKEN);
    });

    test("declining leaves nothing behind", async () => {
      const h = harness({
        isTTY: true,
        input: `${input}\n`,
        fetchImpl: () => jsonResponse(401, {}),
        spawnResults: { ...ghOk },
      });
      const code = await h.run(["--home", tempadHome]);
      expect(code).toBe(1);
      expect(h.stdout()).toContain("Nothing written.");
      expect(existsSync(join(tempadHome, ".env"))).toBe(false);
      expect(h.everything()).not.toContain(MONDAY_TOKEN);
    });

    test("when everything checks out there is no extra question", async () => {
      const h = harness({
        isTTY: true,
        input,
        fetchImpl: () => mondayOk(),
        spawnResults: { ...ghOk },
      });
      expect(await h.run(["--home", tempadHome])).toBe(0);
      expect(h.stdout()).not.toContain("anyway");
    });
  });
});

describe("prompter", () => {
  function prompter(chunks: string[]) {
    const stream = new PassThrough();
    const written: string[] = [];
    const instance = createPrompter(stream, (text) => written.push(text));
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
    return { instance, written: () => written.join("") };
  }

  test("CR, LF and CRLF each end one line only", async () => {
    const { instance } = prompter(["a\r", "b\n", "c\r\nd\r\n"]);
    expect(await instance.ask("")).toBe("a");
    expect(await instance.ask("")).toBe("b");
    expect(await instance.ask("")).toBe("c");
    expect(await instance.ask("")).toBe("d");
    instance.close();
  });

  test("visible mode echoes characters and backspace erases them", async () => {
    const { instance, written } = prompter(["ab\x7fc\n"]);
    expect(await instance.ask("? ")).toBe("ac");
    expect(written()).toBe("? ab\b \bc\n");
    instance.close();
  });

  test("hidden mode echoes nothing, not even the backspace", async () => {
    const { instance, written } = prompter(["sec\x7fret\n"]);
    expect(await instance.ask("? ", { hidden: true })).toBe("seret");
    expect(written()).toBe("? \n");
    instance.close();
  });

  test("arrow keys are ignored and a multi-byte character takes one backspace", async () => {
    const { instance } = prompter(["a\x1b[Dé\x7fb\n"]);
    expect(await instance.ask("")).toBe("ab");
    instance.close();
  });

  test("Ctrl-C rejects; Ctrl-D rejects only on an empty line", async () => {
    const interrupted = prompter(["abc\x03"]);
    await expect(interrupted.instance.ask("")).rejects.toBeInstanceOf(InputAborted);
    interrupted.instance.close();

    const empty = prompter(["\x04"]);
    await expect(empty.instance.ask("")).rejects.toBeInstanceOf(InputAborted);
    empty.instance.close();

    const filled = prompter(["a\x04b\n"]);
    expect(await filled.instance.ask("")).toBe("ab");
    filled.instance.close();
  });

  test("a stream that ends mid-line rejects", async () => {
    const { instance } = prompter(["partial"]);
    await expect(instance.ask("")).rejects.toBeInstanceOf(InputEnded);
    instance.close();
  });

  test("confirm: Enter takes the default, y and yes accept, anything else declines", async () => {
    const { instance } = prompter(["\n", "\n", "y\n", "YES\n", "nope\n"]);
    expect(await instance.confirm("q", false)).toBe(false);
    expect(await instance.confirm("q", true)).toBe(true);
    expect(await instance.confirm("q")).toBe(true);
    expect(await instance.confirm("q")).toBe(true);
    expect(await instance.confirm("q")).toBe(false);
    instance.close();
  });

  test("raw mode is switched on and off around a real terminal", () => {
    const stream = Object.assign(new PassThrough(), {
      isTTY: true,
      modes: [] as boolean[],
      setRawMode(mode: boolean) {
        this.modes.push(mode);
      },
    });
    const instance = createPrompter(stream, () => {});
    instance.close();
    expect(stream.modes).toEqual([true, false]);
  });
});

describe("next steps", () => {
  async function stepsFor(options: {
    settings?: (path: string) => void;
    env?: Record<string, string>;
  }): Promise<string> {
    const h = harness({ env: options.env });
    if (options.settings) options.settings(join(fakeHome, ".claude", "settings.json"));
    expect(await h.run(nonInteractive(VALID, ["--no-verify"]))).toBe(0);
    return h.stdout();
  }

  test("always the plugin, hero init and sync; hook uninstall only when legacy hooks exist", async () => {
    const out = await stepsFor({});
    expect(out).toContain("claude plugin install tempad@hyperlab");
    expect(out).toContain('tempad hero init "<your name>"');
    expect(out).toContain("tempad sync");
    expect(out).not.toContain("w5 hook uninstall");
  });

  test("legacy hooks in ~/.claude/settings.json add the uninstall step", async () => {
    const out = await stepsFor({
      settings: (path) => installHooks(path, "/somewhere/tempad/src/cli.ts"),
    });
    expect(out).toContain("tempad w5 hook uninstall");
  });

  test("other people's hooks in settings.json do not", async () => {
    const out = await stepsFor({
      settings: (path) =>
        writeFileSync(
          path,
          JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }),
        ),
    });
    expect(out).not.toContain("w5 hook uninstall");
  });

  test("CLAUDE_CONFIG_DIR settings are checked too", async () => {
    const configDir = join(root, "alt-claude");
    mkdirSync(configDir, { recursive: true });
    installHooks(join(configDir, "settings.json"), "/somewhere/tempad/src/cli.ts");
    const out = await stepsFor({ env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(out).toContain("tempad w5 hook uninstall");
  });

  test("unparseable settings.json still counts when it holds the marker", async () => {
    const out = await stepsFor({
      settings: (path) => writeFileSync(path, '{ "tempad": true, oops'),
    });
    expect(out).toContain("tempad w5 hook uninstall");
  });
});

describe("tempad init through the CLI", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");

  async function runCli(args: string[], input: "ignore" | "pipe" = "ignore") {
    const child = Bun.spawn([process.execPath, cli, "init", ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: fakeHome },
      stdin: input,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("needs no configuration and opens no database", async () => {
    const result = await runCli([
      "--non-interactive",
      "--no-verify",
      "--home",
      tempadHome,
      ...flagsFor(VALID),
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tempadHome, ".env"))).toBe(true);
    expect(existsSync(join(tempadHome, "tempad.db"))).toBe(false);
    expect(result.stdout).toContain("MONDAY_API_TOKEN=set");
    expect(result.stdout).not.toContain(MONDAY_TOKEN);
  });

  test("defaults the home to ~/.tempad under HOME", async () => {
    const result = await runCli(["--non-interactive", "--no-verify", ...flagsFor(VALID)]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(fakeHome, ".tempad", ".env"))).toBe(true);
  });

  test("without a terminal and without --non-interactive it exits 1 immediately", async () => {
    const result = await runCli(["--home", tempadHome]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--non-interactive");
  });

  test("a missing value exits 1 naming the flag", async () => {
    const result = await runCli(["--non-interactive", "--no-verify", "--home", tempadHome]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--monday-api-token");
  });
});

describe("spawn result shape", () => {
  test("SpawnResult fields are what the fakes in this file provide", () => {
    const result: SpawnResult = { exitCode: 0, stdout: "", timedOut: false };
    expect(Object.keys(result).sort()).toEqual(["exitCode", "stdout", "timedOut"]);
  });
});
