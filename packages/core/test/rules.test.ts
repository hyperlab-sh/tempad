import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules, resolveBoard, resolvePath, resolveRepository } from "../src/config/rules.ts";

function writeToml(content: string): string {
  const path = join(tmpdir(), `tempad-rules-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(path, content);
  return path;
}

describe("loadRules / resolvePath", () => {
  test("expands ~ and matches org/project from named groups", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/work/:org/:project/:rest*"
`);
    const rules = loadRules(path);
    const home = homedir();
    const result = resolvePath(rules, `${home}/work/mosaic/campaigns/apps/web`);
    expect(result).toEqual({
      org: "mosaic",
      project: "campaigns",
      meta: { rest: "apps/web" },
      name: null,
    });
  });

  test("static org field with named project group", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/projects/:project/:rest*"
org = "personal"
`);
    const rules = loadRules(path);
    const home = homedir();
    const result = resolvePath(rules, `${home}/projects/tempad/src`);
    expect(result).toEqual({
      org: "personal",
      project: "tempad",
      meta: { rest: "src" },
      name: null,
    });
  });

  test("scratchpad pattern from spec", () => {
    const path = writeToml(`
[[projects]]
pattern = "/private/tmp/claude-501/-Users-svallory-work-:org-:project-:rest*"
`);
    const rules = loadRules(path);
    const result = resolvePath(
      rules,
      "/private/tmp/claude-501/-Users-svallory-work-tempad-core-foundation-scratchpad",
    );
    expect(result.org).toBe("tempad");
    expect(result.project).toBe("core");
  });

  test("no match returns unassigned", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/work/:org/:project/:rest*"
`);
    const rules = loadRules(path);
    const result = resolvePath(rules, "/some/other/path");
    expect(result).toEqual({ org: "unassigned", project: "unassigned", meta: {}, name: null });
  });

  test("first match wins", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/work/:org/:project/:rest*"
org = "first"

[[projects]]
pattern = "~/work/:org2/:project2/:rest2*"
org = "second"
project = "second-project"
`);
    const rules = loadRules(path);
    const home = homedir();
    const result = resolvePath(rules, `${home}/work/anything/proj`);
    expect(result.org).toBe("first");
  });

  test("rule missing both org and project fails at load time", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/work/:rest*"
`);
    expect(() => loadRules(path)).toThrow();
  });

  test("rule with both pattern and path fails at load time", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/work/:org/:project/:rest*"
path = "~/work/mosaic/coolify"
org = "mosaic"
project = "coolify"
`);
    expect(() => loadRules(path)).toThrow(/exactly one of/);
  });

  test("rule with neither pattern nor path fails at load time", () => {
    const path = writeToml(`
[[projects]]
org = "mosaic"
project = "coolify"
`);
    expect(() => loadRules(path)).toThrow(/exactly one of/);
  });

  test("path rule missing org or project fails at load time", () => {
    const path = writeToml(`
[[projects]]
path = "~/work/mosaic/coolify"
name = "Dev Server"
`);
    expect(() => loadRules(path)).toThrow(/requires "org" and "project"/);
  });

  // Fixtures live under a realpath'd temp dir so results never depend on what
  // the developer's home directory holds (e.g. ~/work being a symlink).
  function withTempRoot(run: (root: string) => void): void {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tempad-rules-root-")));
    try {
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function pathRuleToml(folder: string): string {
    return writeToml(`
[[projects]]
path = ${JSON.stringify(folder)}
name = "Dev Server"
org = "mosaic"
project = "coolify"
`);
  }

  test("path rule matches the folder and a subfolder, not a sibling with the same prefix", () => {
    withTempRoot((root) => {
      mkdirSync(join(root, "coolify"));
      mkdirSync(join(root, "coolify2"));
      const rules = loadRules(pathRuleToml(join(root, "coolify")));

      expect(resolvePath(rules, join(root, "coolify"))).toEqual({
        org: "mosaic",
        project: "coolify",
        meta: {},
        name: "Dev Server",
      });
      expect(resolvePath(rules, join(root, "coolify/deploy/scripts"))).toEqual({
        org: "mosaic",
        project: "coolify",
        meta: {},
        name: "Dev Server",
      });
      expect(resolvePath(rules, join(root, "coolify2"))).toEqual({
        org: "unassigned",
        project: "unassigned",
        meta: {},
        name: null,
      });
    });
  });

  test("path rule normalizes a trailing slash on both the rule and the query path", () => {
    withTempRoot((root) => {
      mkdirSync(join(root, "coolify"));
      const rules = loadRules(pathRuleToml(`${join(root, "coolify")}/`));

      expect(resolvePath(rules, join(root, "coolify")).name).toBe("Dev Server");
      expect(resolvePath(rules, `${join(root, "coolify")}/`).name).toBe("Dev Server");
      expect(resolvePath(rules, `${join(root, "coolify")}/deploy/`).name).toBe("Dev Server");
    });
  });

  if (process.platform === "darwin") {
    test("path rule matches case-insensitively on darwin", () => {
      withTempRoot((root) => {
        mkdirSync(join(root, "coolify"));
        const rules = loadRules(pathRuleToml(join(root, "Coolify")));
        expect(resolvePath(rules, join(root, "coolify")).name).toBe("Dev Server");
        expect(resolvePath(rules, join(root, "coolify/deploy")).name).toBe("Dev Server");
      });
    });
  }

  test("a rule given through a symlinked folder matches a session under the real folder, and the reverse", () => {
    withTempRoot((root) => {
      const realDir = join(root, "real", "coolify");
      const linkDir = join(root, "link");
      mkdirSync(realDir, { recursive: true });
      symlinkSync(join(root, "real"), linkDir);
      const viaLink = join(linkDir, "coolify");

      // Rule via the link, session under the real folder (exists and not yet created).
      const linkRule = loadRules(pathRuleToml(viaLink));
      expect(resolvePath(linkRule, realDir).name).toBe("Dev Server");
      expect(resolvePath(linkRule, join(realDir, "deploy/scripts")).name).toBe("Dev Server");

      // Rule via the real folder, session through the link, subpath that does not exist.
      const realRule = loadRules(pathRuleToml(realDir));
      expect(resolvePath(realRule, viaLink).name).toBe("Dev Server");
      expect(resolvePath(realRule, join(viaLink, "deploy/scripts")).name).toBe("Dev Server");
      expect(resolvePath(realRule, join(linkDir, "coolify2")).name).toBeNull();

      // Rule registered through the link for a folder that does not exist yet.
      const newRule = loadRules(pathRuleToml(join(linkDir, "newproj")));
      expect(resolvePath(newRule, join(root, "real", "newproj", "x")).name).toBe("Dev Server");
    });
  });

  test("path rule resolves symlinks so a linked cwd matches the real folder's rule", () => {
    withTempRoot((root) => {
      const realDir = join(root, "real", "coolify");
      const linkDir = join(root, "link");
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, linkDir);

      const rules = loadRules(pathRuleToml(realDir));
      expect(resolvePath(rules, linkDir).name).toBe("Dev Server");

      mkdirSync(join(realDir, "deploy"), { recursive: true });
      expect(resolvePath(rules, join(linkDir, "deploy")).name).toBe("Dev Server");
    });
  });

  test("path rules match before pattern rules when listed first", () => {
    const path = writeToml(`
[[projects]]
path = "~/work/mosaic/coolify"
name = "Dev Server"
org = "mosaic"
project = "coolify"

[[projects]]
pattern = "~/work/:org/:project/:rest*"
`);
    const rules = loadRules(path);
    const home = homedir();
    const result = resolvePath(rules, `${home}/work/mosaic/coolify`);
    expect(result.name).toBe("Dev Server");
  });

  test("pattern rule can declare a name", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/projects/:project/:rest*"
org = "personal"
name = "Side Projects"
`);
    const rules = loadRules(path);
    const home = homedir();
    const result = resolvePath(rules, `${home}/projects/tempad/src`);
    expect(result.name).toBe("Side Projects");
  });
});

describe("repositories", () => {
  test("exact case-insensitive match on full_name, extra keys become meta", () => {
    const path = writeToml(`
[[repositories]]
full_name = "Mosaicstg/LiUNA-Campaigns"
org = "mosaic"
project = "campaigns"

[[repositories]]
full_name = "Mosaicstg/liuna-campaigns-field"
org = "mosaic"
project = "campaigns"
app = "field"
`);
    const rules = loadRules(path);

    expect(resolveRepository(rules, "mosaicstg/liuna-campaigns")).toEqual({
      org: "mosaic",
      project: "campaigns",
      meta: {},
    });
    expect(resolveRepository(rules, "Mosaicstg/LIUNA-CAMPAIGNS-FIELD")).toEqual({
      org: "mosaic",
      project: "campaigns",
      meta: { app: "field" },
    });
  });

  test("unmatched repository falls back to lowercase owner/repo", () => {
    const path = writeToml(`
[[repositories]]
full_name = "Mosaicstg/LiUNA-Campaigns"
org = "mosaic"
project = "campaigns"
`);
    const rules = loadRules(path);
    expect(resolveRepository(rules, "SomeOrg/SomeRepo")).toEqual({
      org: "someorg",
      project: "somerepo",
      meta: {},
    });
  });

  test("repository entry missing org or project throws at load time", () => {
    const path = writeToml(`
[[repositories]]
full_name = "Mosaicstg/LiUNA-Campaigns"
project = "campaigns"
`);
    expect(() => loadRules(path)).toThrow();
  });
});

describe("boards", () => {
  test("exact case-insensitive match on name", () => {
    const path = writeToml(`
[[boards]]
name = "NJHCQI"
org = "mosaic"
project = "njhcqi"
`);
    const rules = loadRules(path);
    expect(resolveBoard(rules, "njhcqi")).toEqual({
      org: "mosaic",
      project: "njhcqi",
      meta: {},
    });
  });

  test("unmatched board falls back to org=monday, project=slug", () => {
    const path = writeToml(`
[[boards]]
name = "NJHCQI"
org = "mosaic"
project = "njhcqi"
`);
    const rules = loadRules(path);
    expect(resolveBoard(rules, "My Cool Board!")).toEqual({
      org: "monday",
      project: "my-cool-board",
      meta: {},
    });
  });

  test("board entry missing org or project throws at load time", () => {
    const path = writeToml(`
[[boards]]
name = "NJHCQI"
project = "njhcqi"
`);
    expect(() => loadRules(path)).toThrow();
  });
});
