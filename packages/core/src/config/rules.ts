import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePathname } from "node:path";

export interface PathRule {
  pattern?: string;
  path?: string;
  org?: string;
  project?: string;
  name?: string;
}

export interface RepositoryRule {
  full_name: string;
  org: string;
  project: string;
  [key: string]: string;
}

export interface BoardRule {
  name: string;
  org: string;
  project: string;
  [key: string]: string;
}

interface CompiledPatternRule {
  kind: "pattern";
  urlPattern: URLPattern;
  org: string | undefined;
  project: string | undefined;
  name: string | null;
}

interface CompiledPathRule {
  kind: "path";
  absolutePath: string;
  org: string;
  project: string;
  name: string | null;
}

type CompiledRule = CompiledPatternRule | CompiledPathRule;

export interface ResolvedPath {
  org: string;
  project: string;
  meta: Record<string, string>;
  name: string | null;
}

export interface ResolvedEntity {
  org: string;
  project: string;
  meta: Record<string, string>;
}

export interface Rules {
  projects: CompiledRule[];
  repositories: RepositoryRule[];
  boards: BoardRule[];
}

export function expandHome(pattern: string, home: string): string {
  return pattern.startsWith("~") ? home + pattern.slice(1) : pattern;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * `~`-expands, resolves symlinks (resolving only the deepest existing ancestor
 * when the path doesn't exist, e.g. a `path` rule for a folder created after
 * being registered), and strips a trailing slash -- applied to both a
 * `path` rule's configured folder (at load time) and the `cwd` it's matched
 * against (at match time), so `~/work/x/`, a symlinked component, or a
 * differently-cased path (on case-insensitive filesystems) all normalize to
 * the same string before comparison.
 */
export function normalizePathForMatch(path: string, home: string): string {
  const expanded = expandHome(path, home);
  return stripTrailingSlash(realpathThroughExistingAncestor(resolvePathname(expanded)));
}

/**
 * `realpathSync` of the deepest ancestor that exists, with the missing tail
 * re-appended. A `cwd` that no longer exists (or a rule for a folder not yet
 * created) under a symlinked parent must still resolve through that parent,
 * or it would never compare equal to the same location reached via the real
 * path.
 */
function realpathThroughExistingAncestor(absolute: string): string {
  const missing: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

function pathsEqual(a: string, b: string): boolean {
  return process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validateEntityRules<T extends Record<string, unknown>>(
  rawRules: T[],
  kind: "repositories" | "boards",
  keyField: string,
): void {
  rawRules.forEach((rule, index) => {
    if (typeof rule[keyField] !== "string" || (rule[keyField] as string).length === 0) {
      throw new Error(`${kind} entry at index ${index} is missing "${keyField}"`);
    }
    if (typeof rule.org !== "string" || rule.org.length === 0) {
      throw new Error(
        `${kind} entry at index ${index} (${keyField} "${rule[keyField]}") is missing "org"`,
      );
    }
    if (typeof rule.project !== "string" || rule.project.length === 0) {
      throw new Error(
        `${kind} entry at index ${index} (${keyField} "${rule[keyField]}") is missing "project"`,
      );
    }
  });
}

export function loadRules(tomlPath: string): Rules {
  if (!existsSync(tomlPath)) {
    return { projects: [], repositories: [], boards: [] };
  }

  const text = readFileSync(tomlPath, "utf8");
  const parsed = Bun.TOML.parse(text) as {
    projects?: PathRule[];
    repositories?: RepositoryRule[];
    boards?: BoardRule[];
  };
  const rawRules = parsed.projects ?? [];
  const home = homedir();

  const projects = rawRules.map((rule, index) => {
    const hasPattern = rule.pattern !== undefined;
    const hasPath = rule.path !== undefined;

    if (hasPattern === hasPath) {
      throw new Error(
        `projects entry at index ${index} must have exactly one of "pattern" or "path"`,
      );
    }

    if (hasPath) {
      if (!rule.org || !rule.project) {
        throw new Error(
          `projects entry at index ${index} (path "${rule.path}") requires "org" and "project"`,
        );
      }
      const absolutePath = normalizePathForMatch(rule.path as string, home);
      return {
        kind: "path" as const,
        absolutePath,
        org: rule.org,
        project: rule.project,
        name: rule.name ?? null,
      };
    }

    const pathname = expandHome(rule.pattern as string, home);
    const urlPattern = new URLPattern({ pathname });

    const groupNames = extractGroupNames(pathname);
    const hasOrgGroup = groupNames.has("org");
    const hasProjectGroup = groupNames.has("project");

    if (!rule.org && !hasOrgGroup) {
      throw new Error(`Rule at index ${index} (pattern "${rule.pattern}") cannot supply "org"`);
    }
    if (!rule.project && !hasProjectGroup) {
      throw new Error(`Rule at index ${index} (pattern "${rule.pattern}") cannot supply "project"`);
    }

    return {
      kind: "pattern" as const,
      urlPattern,
      org: rule.org,
      project: rule.project,
      name: rule.name ?? null,
    };
  });

  const repositories = parsed.repositories ?? [];
  validateEntityRules(repositories, "repositories", "full_name");

  const boards = parsed.boards ?? [];
  validateEntityRules(boards, "boards", "name");

  return { projects, repositories, boards };
}

function extractGroupNames(pathname: string): Set<string> {
  const names = new Set<string>();
  const regex = /:([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (const match of pathname.matchAll(regex)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return names;
}

/**
 * True when `candidatePath` is `underPath` itself or a descendant of it.
 * Both are expected already normalized (see `normalizePathForMatch`) --
 * exported so callers matching against a `path` rule's folder outside
 * `resolvePath` (e.g. `reresolveSessions`) use the exact same rule: trailing
 * slash stripped, symlinks resolved, case-insensitive on darwin only.
 */
export function matchesPath(underPath: string, candidatePath: string): boolean {
  if (pathsEqual(candidatePath, underPath)) return true;
  const prefix = `${underPath}/`;
  const [a, b] =
    process.platform === "darwin"
      ? [candidatePath.toLowerCase(), prefix.toLowerCase()]
      : [candidatePath, prefix];
  return a.startsWith(b);
}

export function resolvePath(rules: Rules, absolutePath: string): ResolvedPath {
  const home = homedir();
  const normalizedInput = normalizePathForMatch(absolutePath, home);

  for (const rule of rules.projects) {
    if (rule.kind === "path") {
      if (!matchesPath(rule.absolutePath, normalizedInput)) continue;
      return { org: rule.org, project: rule.project, meta: {}, name: rule.name };
    }

    const match = rule.urlPattern.exec({ pathname: absolutePath });
    if (!match) continue;

    const groups = match.pathname.groups as Record<string, string | undefined>;
    const org = rule.org ?? groups.org;
    const project = rule.project ?? groups.project;

    if (org === undefined || project === undefined) continue;

    const meta: Record<string, string> = {};
    for (const [name, value] of Object.entries(groups)) {
      if (name === "org" || name === "project" || value === undefined) continue;
      meta[name] = value;
    }

    return { org, project, meta, name: rule.name };
  }

  return { org: "unassigned", project: "unassigned", meta: {}, name: null };
}

function metaFromEntity<T extends Record<string, unknown>>(
  rule: T,
  excludeKeys: string[],
): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const [key, value] of Object.entries(rule)) {
    if (excludeKeys.includes(key)) continue;
    if (typeof value === "string") meta[key] = value;
  }
  return meta;
}

export function resolveRepository(rules: Rules, fullName: string): ResolvedEntity {
  const lowerFullName = fullName.toLowerCase();
  const match = rules.repositories.find((rule) => rule.full_name.toLowerCase() === lowerFullName);
  if (match) {
    return {
      org: match.org,
      project: match.project,
      meta: metaFromEntity(match, ["full_name", "org", "project"]),
    };
  }

  const [owner, repo] = fullName.split("/");
  return {
    org: (owner ?? fullName).toLowerCase(),
    project: (repo ?? fullName).toLowerCase(),
    meta: {},
  };
}

export function resolveBoard(rules: Rules, boardName: string): ResolvedEntity {
  const lowerName = boardName.toLowerCase();
  const match = rules.boards.find((rule) => rule.name.toLowerCase() === lowerName);
  if (match) {
    return {
      org: match.org,
      project: match.project,
      meta: metaFromEntity(match, ["name", "org", "project"]),
    };
  }

  return { org: "monday", project: slugify(boardName), meta: {} };
}
