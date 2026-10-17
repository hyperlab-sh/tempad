import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const REPOSITORY_ROOT = join(PACKAGE_ROOT, "..", "..");

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  license: string;
  description: string;
  bin: Record<string, string>;
  files: string[];
  engines: Record<string, string>;
  repository: { type: string; url: string; directory: string };
  homepage: string;
  bugs: { url: string };
  keywords: string[];
}

const manifest = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
) as PackageManifest;
const plugin = JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
) as { name: string; version: string };

describe("release: package and plugin versions", () => {
  test("the npm package and the Claude Code plugin share one version", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(plugin.version).toBe(manifest.version);
  });

  test("the npm package is scoped, the plugin is named tempad", () => {
    expect(manifest.name).toBe("@hyperlab.sh/tempad");
    expect(plugin.name).toBe("tempad");
  });
});

describe("release: package.json is publishable", () => {
  test("is not private", () => {
    expect(manifest.private).toBeUndefined();
  });

  test("declares the registry metadata", () => {
    expect(manifest.description.length).toBeGreaterThan(20);
    expect(manifest.license).toBe("MIT");
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/hyperlab-sh/tempad.git",
      directory: "packages/core",
    });
    expect(manifest.homepage).toContain("github.com/hyperlab-sh/tempad");
    expect(manifest.bugs.url).toContain("github.com/hyperlab-sh/tempad/issues");
    expect(manifest.keywords.length).toBeGreaterThan(0);
  });

  test("requires the bun version the tool is tested on", () => {
    expect(manifest.engines.bun).toBe(">=1.4.2");
  });

  test("the bin points at an executable file with a bun shebang", () => {
    expect(manifest.bin).toEqual({ tempad: "./src/cli.ts" });
    const path = join(PACKAGE_ROOT, manifest.bin.tempad as string);
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(readFileSync(path, "utf8").split("\n")[0]).toMatch(/^#!\/usr\/bin\/env -S bun /);
  });

  test("the LICENSE inside the package is the repository LICENSE", () => {
    expect(readFileSync(join(PACKAGE_ROOT, "LICENSE"), "utf8")).toBe(
      readFileSync(join(REPOSITORY_ROOT, "LICENSE"), "utf8"),
    );
  });
});

describe("release: files whitelist", () => {
  test("ships exactly the runtime directories and the two documents", () => {
    expect([...manifest.files].sort()).toEqual(["LICENSE", "README.md", "hooks", "skills", "src"]);
  });

  test("every whitelisted entry exists", () => {
    for (const entry of manifest.files) {
      expect(existsSync(join(PACKAGE_ROOT, entry))).toBe(true);
    }
  });

  test("never lists the example config that holds real clients and paths", () => {
    const listed = manifest.files.join("\n");
    expect(listed).not.toContain("tempad.example.toml");
    expect(listed).not.toContain(".env");
    expect(listed).not.toContain("test");
  });

  test("migrations, the skill and the hook scripts the runtime resolves are inside the shipped directories", () => {
    const runtimeFiles = [
      "src/db/migrations/0001_initial.sql",
      "skills/quest/SKILL.md",
      "skills/setup/SKILL.md",
      "hooks/w5-stop.sh",
      "hooks/w5-prompt.sh",
      "hooks/w5-common.sh",
      "src/cli.ts",
    ];
    for (const file of runtimeFiles) {
      expect(existsSync(join(PACKAGE_ROOT, file))).toBe(true);
      expect(manifest.files.some((entry) => file.startsWith(`${entry}/`) || file === entry)).toBe(
        true,
      );
    }
  });

  test("no test file lives under the shipped src directory", () => {
    const stack = [join(PACKAGE_ROOT, "src")];
    const offenders: string[] = [];
    while (stack.length > 0) {
      const directory = stack.pop() as string;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the plugin's hook commands point at scripts that ship in the package", () => {
    const hooksJson = readFileSync(join(REPOSITORY_ROOT, "hooks", "hooks.json"), "utf8");
    const scripts = [...hooksJson.matchAll(/packages\/core\/(hooks\/[\w.-]+\.sh)/g)].map(
      (match) => match[1] as string,
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(existsSync(join(PACKAGE_ROOT, script))).toBe(true);
    }
  });
});
