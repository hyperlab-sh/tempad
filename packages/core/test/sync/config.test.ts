import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SYNC_BATCH_SIZE,
  isSyncEnabled,
  loadSyncConfig,
  validateSyncUrl,
} from "../../src/sync/config";
import { temporaryDirectory } from "./helpers";

let home: string;

beforeEach(() => {
  home = temporaryDirectory("tempad-sync-config-");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function toml(text: string): void {
  writeFileSync(join(home, "tempad.toml"), text);
}

const TOKEN = { TEMPAD_SYNC_TOKEN: "jwt.token.value" };

describe("loadSyncConfig", () => {
  test("no tempad.toml at all is disabled", () => {
    expect(loadSyncConfig(home, TOKEN)).toBeNull();
    expect(isSyncEnabled(home)).toBe(false);
  });

  test("a tempad.toml without [sync] is disabled, even with a token set", () => {
    toml('[w5]\nmode = "declared"\n');
    expect(loadSyncConfig(home, TOKEN)).toBeNull();
    expect(isSyncEnabled(home)).toBe(false);
  });

  test("enabled = false is disabled and validates nothing else", () => {
    toml('[sync]\nenabled = false\nurl = "ftp://nope"\n');
    expect(loadSyncConfig(home, {})).toBeNull();
    expect(isSyncEnabled(home)).toBe(false);
  });

  test("the section enables sync by default, with the default batch size", () => {
    toml('[sync]\nurl = "libsql://sync.example.ts.net"\n');
    expect(loadSyncConfig(home, TOKEN)).toEqual({
      url: "libsql://sync.example.ts.net",
      token: "jwt.token.value",
      batchSize: DEFAULT_SYNC_BATCH_SIZE,
    });
    expect(isSyncEnabled(home)).toBe(true);
  });

  test("a non-boolean enabled is rejected", () => {
    toml('[sync]\nenabled = "yes"\nurl = "libsql://x.example"\n');
    expect(() => loadSyncConfig(home, TOKEN)).toThrow("[sync].enabled must be true or false");
  });

  test("[sync] that is not a table is rejected", () => {
    toml('sync = "on"\n');
    expect(() => loadSyncConfig(home, TOKEN)).toThrow("[sync] must be a table");
  });

  test("url is required when enabled", () => {
    toml("[sync]\nenabled = true\n");
    expect(() => loadSyncConfig(home, TOKEN)).toThrow("[sync].url is required");
  });

  test("an unparseable url is rejected", () => {
    toml('[sync]\nurl = "not-a-url"\n');
    expect(() => loadSyncConfig(home, TOKEN)).toThrow("[sync].url is not a valid URL");
  });

  for (const url of ["libsql://h.example", "https://h.example", "libsql://h.example:8080"]) {
    test(`TLS scheme accepted: ${url}`, () => {
      toml(`[sync]\nurl = "${url}"\n`);
      expect(loadSyncConfig(home, TOKEN)?.url).toBe(url);
    });
  }

  for (const [url, rebuilt] of [
    ["wss://h.example:443", "wss://h.example"],
    ["https://H.Example/", "https://h.example"],
    ["https://h.example/db/main", "https://h.example/db/main"],
    ["http://127.0.0.%31:8080", "http://127.0.0.1:8080"],
  ]) {
    test(`the url handed on is rebuilt from the checked parse: ${url}`, () => {
      toml(`[sync]\nurl = "${url}"\n`);
      expect(loadSyncConfig(home, TOKEN)?.url).toBe(rebuilt as string);
    });
  }

  // review-3 M2: WHATWG URL reads `\` as `/`, @libsql/core's parser does not.
  for (const url of [
    "http://127.0.0.1\\@evil.com:8080",
    "ws://localhost\\@evil.com/",
    "http://localhost\\.evil.com",
    "https://h.example\\path",
  ]) {
    test(`a backslash is rejected: ${url}`, () => {
      toml(`[sync]\nurl = '${url}'\n`);
      expect(() => loadSyncConfig(home, TOKEN)).toThrow("must not contain backslashes");
    });
  }

  for (const [label, url] of [
    ["tab", "http://127.0.0.1\t@evil.com:8080"],
    ["newline", "http://127.0.0.1\n@evil.com:8080"],
    ["space", " http://127.0.0.1:8080"],
    ["NUL", "http://127.0.0.1\u0000.evil.com"],
    ["DEL", "http://127.0.0.1\u007f.evil.com"],
  ]) {
    test(`a control character or whitespace is rejected: ${label}`, () => {
      // Straight to the validator: Bun.TOML.parse cannot be trusted to carry
      // an escaped NUL (it failed with "Failed to parse JSON" depending on the
      // working directory), and the check must not depend on the TOML layer.
      expect(() => validateSyncUrl(url)).toThrow("control characters");
    });
  }

  test("a control character reaches the guard through tempad.toml too", () => {
    toml(`[sync]\nurl = "http://127.0.0.1\\t@evil.com:8080"\n`);
    expect(() => loadSyncConfig(home, TOKEN)).toThrow("control characters");
  });

  test("the libsql client connects to exactly the host the guard checked", async () => {
    // The real parser @libsql/client uses, resolved through the client.
    const client = Bun.resolveSync("@libsql/client/web", join(import.meta.dir, "..", "..", "src"));
    const { expandConfig } = (await import(Bun.resolveSync("@libsql/core/config", client))) as {
      expandConfig: (
        config: { url: string; authToken?: string },
        preferHttp: boolean,
      ) => { scheme: string; tls: boolean; authority?: { host: string; port?: number } };
    };
    for (const url of [
      "http://127.0.0.1:8080",
      "ws://localhost:8080",
      "http://[::1]:8080",
      "http://127.0.0.%31:8080",
      "libsql://h.example",
      "https://h.example:8443/db",
    ]) {
      toml(`[sync]\nurl = "${url}"\n`);
      const accepted = loadSyncConfig(home, TOKEN)?.url as string;
      const checked = new URL(accepted);
      const seen = expandConfig({ url: accepted, authToken: "t" }, true);
      expect(seen.authority?.host.replace(/^\[|\]$/g, "")).toBe(
        checked.hostname.replace(/^\[|\]$/g, ""),
      );
      expect(seen.tls).toBe(checked.protocol !== "http:" && checked.protocol !== "ws:");
    }
  });

  for (const url of [
    "http://127.0.0.1:8080",
    "ws://localhost:8080",
    "http://[::1]:8080",
    "http://127.1.2.3",
  ]) {
    test(`plain text accepted on loopback: ${url}`, () => {
      toml(`[sync]\nurl = "${url}"\n`);
      expect(loadSyncConfig(home, TOKEN)?.url).toBe(url);
    });
  }

  for (const url of [
    "http://sync.example.ts.net",
    "ws://10.0.0.5:8080",
    "http://localhost.evil.example",
  ]) {
    test(`plain text rejected off loopback: ${url}`, () => {
      toml(`[sync]\nurl = "${url}"\n`);
      expect(() => loadSyncConfig(home, TOKEN)).toThrow("non-loopback host");
    });
  }

  for (const url of [
    "libsql://sync.example.com:8080?tls=0",
    "https://sync.example.com?tls=0",
    "libsql://sync.example.com?authToken=secret-in-toml",
    "http://127.0.0.1:8080?tls=1",
    "libsql://sync.example.com?",
    "libsql://sync.example.com#frag",
  ]) {
    test(`a query string or fragment is rejected, loopback or not: ${url}`, () => {
      toml(`[sync]\nurl = "${url}"\n`);
      expect(() => loadSyncConfig(home, TOKEN)).toThrow("must not have a query string or fragment");
    });
  }

  test("the rejected url, which may hold a token, is not echoed in the error", () => {
    toml('[sync]\nurl = "libsql://h.example?authToken=secret-in-toml"\n');
    expect(() => loadSyncConfig(home, TOKEN)).not.toThrow("secret-in-toml");
    expect(() => loadSyncConfig(home, TOKEN)).toThrow();
  });

  for (const url of [
    "libsql://user:pass@sync.example.com",
    "https://token@sync.example.com",
    "http://user:pass@127.0.0.1:8080",
  ]) {
    test(`user info is rejected: ${url}`, () => {
      toml(`[sync]\nurl = "${url}"\n`);
      expect(() => loadSyncConfig(home, TOKEN)).toThrow("must not contain user info");
    });
  }

  test("an unsupported scheme is rejected", () => {
    toml('[sync]\nurl = "file:///tmp/x.db"\n');
    expect(() => loadSyncConfig(home, TOKEN)).toThrow("scheme file: is not supported");
  });

  test("batch_size accepts a positive integer", () => {
    toml('[sync]\nurl = "libsql://h.example"\nbatch_size = 50\n');
    expect(loadSyncConfig(home, TOKEN)?.batchSize).toBe(50);
  });

  for (const value of ["0", "-5", "1.5", '"100"']) {
    test(`batch_size rejects ${value}`, () => {
      toml(`[sync]\nurl = "libsql://h.example"\nbatch_size = ${value}\n`);
      expect(() => loadSyncConfig(home, TOKEN)).toThrow(
        "[sync].batch_size must be a positive integer",
      );
    });
  }

  test("the token is required when enabled, and never defaulted", () => {
    toml('[sync]\nurl = "libsql://h.example"\n');
    expect(() => loadSyncConfig(home, {})).toThrow(
      "TEMPAD_SYNC_TOKEN is required when [sync] is enabled",
    );
    expect(() => loadSyncConfig(home, { TEMPAD_SYNC_TOKEN: "  " })).toThrow(
      "TEMPAD_SYNC_TOKEN is required when [sync] is enabled",
    );
  });

  test("the token falls back to TEMPAD_HOME/.env, and process env wins over it", () => {
    toml('[sync]\nurl = "libsql://h.example"\n');
    writeFileSync(join(home, ".env"), 'HOST_SLUG=x\nTEMPAD_SYNC_TOKEN="from-dotenv"\n');
    expect(loadSyncConfig(home, {})?.token).toBe("from-dotenv");
    expect(loadSyncConfig(home, { TEMPAD_SYNC_TOKEN: "from-env" })?.token).toBe("from-env");
  });

  test("the token is not in any error message", () => {
    toml('[sync]\nurl = "http://sync.example.ts.net"\n');
    try {
      loadSyncConfig(home, { TEMPAD_SYNC_TOKEN: "secret-jwt" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(String(error)).not.toContain("secret-jwt");
    }
  });
});
