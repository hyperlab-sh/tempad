import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { LoadedConfig } from "../config/env.ts";
import {
  expandHome,
  loadRules,
  matchesPath,
  normalizePathForMatch,
  resolvePath,
} from "../config/rules.ts";
import { getSyncState } from "../db/sync-state.ts";
import type { Collector, SyncOptions, SyncSummary } from "./types.ts";

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
}

interface MessagePayload {
  role?: string;
  model?: string;
  content?: string | ContentBlock[];
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

interface JsonlLine {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  cwd?: string;
  gitBranch?: string;
  origin?: { kind?: string };
  message?: MessagePayload;
  customTitle?: string;
  agentName?: string;
  entrypoint?: string;
  userType?: string;
}

interface ParsedMessage {
  uuid: string;
  sessionId: string;
  ts: string;
  role: string;
  isSidechain: boolean;
  originKind: string | null;
  model: string | null;
  textPreview: string | null;
  toolName: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  hasToolUse: boolean;
}

interface SessionAccumulator {
  id: string | undefined;
  claudeDir: string;
  projectDir: string;
  filePath: string;
  cwd: string | undefined;
  gitBranch: string | undefined;
  startedAt: string | undefined;
  endedAt: string | undefined;
  messageCount: number;
  toolCallCount: number;
  models: Set<string>;
  fileMtime: string;
  customTitle: string | undefined;
  agentName: string | undefined;
  firstHumanText: string | undefined;
  entrypoint: string | undefined;
  userType: string | undefined;
}

async function* readLines(path: string): AsyncGenerator<string> {
  const stream = Bun.file(path).stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        yield buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

function extractTextPreview(content: string | ContentBlock[] | undefined): string | null {
  if (content === undefined) return null;
  if (typeof content === "string") return content.slice(0, 500);

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  if (texts.length === 0) return null;
  return texts.join("").slice(0, 500);
}

function extractToolName(content: string | ContentBlock[] | undefined): string | null {
  if (content === undefined || typeof content === "string") return null;
  for (const block of content) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      return block.name;
    }
  }
  return null;
}

function isPlainHumanText(content: string | ContentBlock[] | undefined): string | undefined {
  if (typeof content !== "string") return undefined;
  if (content.startsWith("<")) return undefined;
  return content;
}

function decodeProjectDir(projectDir: string): string {
  if (existsSync(projectDir)) return projectDir;

  const segments = projectDir.split("-").filter((segment) => segment.length > 0);

  function search(index: number, candidate: string): string | null {
    if (index >= segments.length) return existsSync(candidate) ? candidate : null;
    const segment = segments[index] as string;

    const asSlash = `${candidate}/${segment}`;
    if (existsSync(asSlash)) {
      const result = search(index + 1, asSlash);
      if (result !== null) return result;
    }

    const asDash = candidate.length > 0 ? `${candidate}-${segment}` : `/${segment}`;
    return search(index + 1, asDash);
  }

  return search(0, "") ?? projectDir;
}

function parseLine(
  raw: string,
  sessionAccumulator: SessionAccumulator,
): { message: ParsedMessage | null; malformed: boolean } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { message: null, malformed: false };

  let line: JsonlLine;
  try {
    line = JSON.parse(trimmed) as JsonlLine;
  } catch {
    return { message: null, malformed: true };
  }

  if (sessionAccumulator.id === undefined && line.sessionId !== undefined) {
    sessionAccumulator.id = line.sessionId;
  }

  if (line.type === "custom-title" && typeof line.customTitle === "string") {
    sessionAccumulator.customTitle = line.customTitle;
    return { message: null, malformed: false };
  }
  if (line.type === "agent-name" && typeof line.agentName === "string") {
    sessionAccumulator.agentName = line.agentName;
    return { message: null, malformed: false };
  }

  const messageType = line.type;
  if (
    (messageType !== "user" && messageType !== "assistant" && messageType !== "system") ||
    line.timestamp === undefined
  ) {
    return { message: null, malformed: false };
  }
  const timestamp = line.timestamp;

  if (line.uuid === undefined) {
    return { message: null, malformed: true };
  }
  const uuid = line.uuid;

  if (sessionAccumulator.cwd === undefined && typeof line.cwd === "string") {
    sessionAccumulator.cwd = line.cwd;
  }
  if (sessionAccumulator.gitBranch === undefined && typeof line.gitBranch === "string") {
    sessionAccumulator.gitBranch = line.gitBranch;
  }

  if (messageType === "user") {
    const originKind = line.origin?.kind;
    const content = line.message?.content;
    if (sessionAccumulator.firstHumanText === undefined) {
      if (originKind === "human") {
        const text = extractTextPreview(content);
        if (text !== null) sessionAccumulator.firstHumanText = text;
      } else if (line.origin === undefined) {
        const text = isPlainHumanText(content);
        if (text !== undefined) sessionAccumulator.firstHumanText = text;
      }
    }
    if (sessionAccumulator.entrypoint === undefined && typeof line.entrypoint === "string") {
      sessionAccumulator.entrypoint = line.entrypoint;
    }
    if (sessionAccumulator.userType === undefined && typeof line.userType === "string") {
      sessionAccumulator.userType = line.userType;
    }
  }

  const role: string = line.message?.role ?? messageType;
  const model = line.message?.model ?? null;
  if (model !== null) sessionAccumulator.models.add(model);

  const usage = line.message?.usage;
  const tokensIn =
    usage === undefined
      ? null
      : (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
  const tokensOut = usage?.output_tokens ?? null;

  const toolName = extractToolName(line.message?.content);

  const message: ParsedMessage = {
    uuid,
    sessionId: line.sessionId ?? sessionAccumulator.id ?? basename(sessionAccumulator.filePath),
    ts: timestamp,
    role,
    isSidechain: line.isSidechain === true,
    originKind: line.origin?.kind ?? null,
    model,
    textPreview: extractTextPreview(line.message?.content),
    toolName,
    tokensIn,
    tokensOut,
    hasToolUse: toolName !== null,
  };

  return { message, malformed: false };
}

type TitleSource = "custom-title" | "agent-name" | "first-message" | "none";

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function resolveTitle(sessionAccumulator: SessionAccumulator): {
  title: string | null;
  source: TitleSource;
} {
  if (sessionAccumulator.customTitle !== undefined) {
    return {
      title: collapseWhitespace(sessionAccumulator.customTitle).slice(0, 120),
      source: "custom-title",
    };
  }
  if (sessionAccumulator.agentName !== undefined) {
    return {
      title: collapseWhitespace(sessionAccumulator.agentName).slice(0, 120),
      source: "agent-name",
    };
  }
  if (sessionAccumulator.firstHumanText !== undefined) {
    return {
      title: collapseWhitespace(sessionAccumulator.firstHumanText).slice(0, 120),
      source: "first-message",
    };
  }
  return { title: null, source: "none" };
}

async function processFile(
  filePath: string,
  claudeDir: string,
  projectDir: string,
  fileMtime: string,
  since: string | undefined,
): Promise<{
  session: SessionAccumulator;
  messages: ParsedMessage[];
  malformedCount: number;
}> {
  const sessionAccumulator: SessionAccumulator = {
    id: undefined,
    claudeDir,
    projectDir,
    filePath,
    cwd: undefined,
    gitBranch: undefined,
    startedAt: undefined,
    endedAt: undefined,
    messageCount: 0,
    toolCallCount: 0,
    models: new Set(),
    fileMtime,
    customTitle: undefined,
    agentName: undefined,
    firstHumanText: undefined,
    entrypoint: undefined,
    userType: undefined,
  };

  const messages: ParsedMessage[] = [];
  let malformedCount = 0;

  for await (const rawLine of readLines(filePath)) {
    const { message, malformed } = parseLine(rawLine, sessionAccumulator);
    if (malformed) {
      malformedCount += 1;
      continue;
    }
    if (message === null) continue;

    messages.push(message);
    sessionAccumulator.messageCount += 1;
    if (message.hasToolUse && message.role === "assistant") {
      sessionAccumulator.toolCallCount += 1;
    }
    if (sessionAccumulator.startedAt === undefined || message.ts < sessionAccumulator.startedAt) {
      sessionAccumulator.startedAt = message.ts;
    }
    if (sessionAccumulator.endedAt === undefined || message.ts > sessionAccumulator.endedAt) {
      sessionAccumulator.endedAt = message.ts;
    }
  }

  if (
    since !== undefined &&
    sessionAccumulator.endedAt !== undefined &&
    sessionAccumulator.endedAt < since
  ) {
    return { session: sessionAccumulator, messages: [], malformedCount };
  }

  return { session: sessionAccumulator, messages, malformedCount };
}

interface ClaudeQueries {
  insertMessage: ReturnType<Database["query"]>;
  upsertSession: ReturnType<Database["query"]>;
  selectExisting: ReturnType<Database["query"]>;
}

function prepareQueries(database: Database): ClaudeQueries {
  const insertMessage = database.query(
    `INSERT OR IGNORE INTO claude_messages
      (uuid, session_id, ts, role, is_sidechain, origin_kind, model, text_preview, tool_name, tokens_in, tokens_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const upsertSession = database.query(
    `INSERT INTO claude_sessions
      (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, project_name, title,
       title_source, entrypoint, user_type, git_branch, started_at, ended_at, message_count,
       tool_call_count, models, host_slug, file_mtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       claude_dir = excluded.claude_dir,
       project_dir = excluded.project_dir,
       file_path = excluded.file_path,
       cwd = excluded.cwd,
       org = excluded.org,
       project = excluded.project,
       path_meta = excluded.path_meta,
       project_name = excluded.project_name,
       title = excluded.title,
       title_source = excluded.title_source,
       entrypoint = excluded.entrypoint,
       user_type = excluded.user_type,
       git_branch = excluded.git_branch,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       message_count = excluded.message_count,
       tool_call_count = excluded.tool_call_count,
       models = excluded.models,
       host_slug = excluded.host_slug,
       file_mtime = excluded.file_mtime`,
  );

  const selectExisting = database.query(
    "SELECT file_mtime as fileMtime, message_count as messageCount, title as title, title_source as titleSource FROM claude_sessions WHERE id = ?",
  );

  return { insertMessage, upsertSession, selectExisting };
}

interface SyncFileResult {
  sessionsInserted: number;
  sessionsUpdated: number;
  messagesInserted: number;
  warnings: string[];
}

async function syncFile(
  filePath: string,
  claudeDir: string,
  config: LoadedConfig<"hostSlug">,
  rules: ReturnType<typeof loadRules>,
  queries: ClaudeQueries,
  since: string | undefined,
): Promise<SyncFileResult> {
  const warnings: string[] = [];
  let sessionsInserted = 0;
  let sessionsUpdated = 0;
  let messagesInserted = 0;

  const stats = statSync(filePath);
  const mtime = stats.mtime;
  const projectDir = basename(filePath.slice(0, filePath.lastIndexOf("/")));
  const fileMtime = mtime.toISOString();

  const { session, messages, malformedCount } = await processFile(
    filePath,
    claudeDir,
    projectDir,
    fileMtime,
    since,
  );

  if (malformedCount > 0) {
    warnings.push(`${filePath}: ${malformedCount} malformed lines`);
  }

  if (messages.length === 0) {
    return { sessionsInserted, sessionsUpdated, messagesInserted, warnings };
  }

  const sessionId = session.id ?? basename(filePath, ".jsonl");
  const cwd = session.cwd;
  const resolveTarget = cwd ?? decodeProjectDir(projectDir);
  const resolved = resolvePath(rules, resolveTarget);

  const existing = queries.selectExisting.get(sessionId) as {
    fileMtime: string;
    messageCount: number;
    title: string | null;
    titleSource: string | null;
  } | null;

  const { title, source: titleSource } = resolveTitle(session);

  const unchanged =
    existing !== null &&
    existing.fileMtime === fileMtime &&
    existing.messageCount === session.messageCount &&
    existing.title === title &&
    existing.titleSource === titleSource;

  if (!unchanged) {
    queries.upsertSession.run(
      sessionId,
      claudeDir,
      projectDir,
      filePath,
      cwd ?? null,
      resolved.org,
      resolved.project,
      Object.keys(resolved.meta).length > 0 ? JSON.stringify(resolved.meta) : null,
      resolved.name,
      title,
      titleSource,
      session.entrypoint ?? null,
      session.userType ?? null,
      session.gitBranch ?? null,
      session.startedAt as string,
      session.endedAt as string,
      session.messageCount,
      session.toolCallCount,
      JSON.stringify([...session.models]),
      config.hostSlug,
      fileMtime,
    );

    if (existing === null) {
      sessionsInserted += 1;
    } else {
      sessionsUpdated += 1;
    }
  }

  for (const message of messages) {
    const result = queries.insertMessage.run(
      message.uuid,
      sessionId,
      message.ts,
      message.role,
      message.isSidechain ? 1 : 0,
      message.originKind,
      message.model,
      message.textPreview,
      message.toolName,
      message.tokensIn,
      message.tokensOut,
    );
    if (result.changes > 0) messagesInserted += 1;
  }

  return { sessionsInserted, sessionsUpdated, messagesInserted, warnings };
}

export async function syncOneSessionFile(
  database: Database,
  config: LoadedConfig<"claudeDirs" | "hostSlug">,
  filePath: string,
): Promise<SyncSummary> {
  const rulesPath = join(config.home, "tempad.toml");
  const rules = loadRules(rulesPath);
  const queries = prepareQueries(database);
  const claudeDir =
    config.claudeDirs.find((dir) => filePath.startsWith(`${dir}/`)) ?? config.claudeDirs[0] ?? "";

  const result = await syncFile(filePath, claudeDir, config, rules, queries, undefined);

  return {
    source: "claude",
    inserted: result.sessionsInserted,
    updated: result.sessionsUpdated,
    deleted: 0,
    warnings: result.warnings,
  };
}

/**
 * Re-resolves org/project/path_meta/project_name for every stored session
 * whose `cwd` falls under `underPath`, without re-reading session files --
 * used after a `tempad project register` inserts a new rule that changes
 * where existing sessions resolve to.
 */
export function reresolveSessions(
  database: Database,
  rules: ReturnType<typeof loadRules>,
  underPath: string,
  home: string = homedir(),
): number {
  const update = database.query(
    "UPDATE claude_sessions SET org = ?, project = ?, path_meta = ?, project_name = ? WHERE id = ?",
  );
  const normalizedUnderPath = normalizePathForMatch(underPath, home);

  // Prefilters candidates in SQL by (exact match or `/`-prefixed descendant)
  // against both the plain `~`-expanded path and its realpath (when it
  // differs, e.g. `underPath` itself is reached through a symlink), so a
  // database with sessions scattered across many unrelated projects never
  // realpath-resolves rows that can't possibly be under `underPath` -- only
  // rows this prefilter lets through pay for the exact/normalized comparison
  // below. A trailing slash on `underPath` is stripped before building the
  // prefixes (matching `normalizePathForMatch`'s own normalization), and the
  // comparison is case-insensitive on darwin (`LOWER()` both sides) to widen
  // the prefilter rather than narrow it -- this can only let through a few
  // extra rows for the exact check to reject, never drop a real match. It
  // does not resolve a symlink inside `cwd` itself (only in `underPath`),
  // which is the one gap `matchesPath`'s full normalization still covers for
  // direct calls to `resolvePath`, just not for this SQL-prefiltered path.
  const stripTrailingSlash = (path: string): string =>
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const expandedUnderPath = stripTrailingSlash(expandHome(underPath, home));
  const candidatePrefixes = new Set([expandedUnderPath, normalizedUnderPath]);
  const conditions: string[] = [];
  const params: string[] = [];
  const caseInsensitive = process.platform === "darwin";
  const cwdColumn = caseInsensitive ? "LOWER(cwd)" : "cwd";
  for (const prefix of candidatePrefixes) {
    const value = caseInsensitive ? prefix.toLowerCase() : prefix;
    conditions.push(`${cwdColumn} = ?`, `${cwdColumn} LIKE ? || '/%'`);
    params.push(value, value);
  }

  const rows = database
    .query(
      `SELECT id, cwd, project_dir FROM claude_sessions WHERE cwd IS NOT NULL AND (${conditions.join(" OR ")})`,
    )
    .all(...params) as { id: string; cwd: string | null; project_dir: string }[];

  let moved = 0;
  for (const row of rows) {
    const resolveTarget = row.cwd ?? decodeProjectDir(row.project_dir);
    if (!matchesPath(normalizedUnderPath, normalizePathForMatch(resolveTarget, home))) continue;

    const resolved = resolvePath(rules, resolveTarget);
    update.run(
      resolved.org,
      resolved.project,
      Object.keys(resolved.meta).length > 0 ? JSON.stringify(resolved.meta) : null,
      resolved.name,
      row.id,
    );
    moved += 1;
  }
  return moved;
}

export const CLAUDE_NEEDS = ["claudeDirs", "since", "hostSlug"] as const;

export const claudeCollector: Collector<(typeof CLAUDE_NEEDS)[number]> = {
  name: "claude",
  needs: CLAUDE_NEEDS,

  async sync(
    database: Database,
    config: LoadedConfig<(typeof CLAUDE_NEEDS)[number]>,
    options: SyncOptions,
  ): Promise<SyncSummary> {
    const warnings: string[] = [];
    let sessionsInserted = 0;
    let sessionsUpdated = 0;
    let messagesInserted = 0;

    const syncState = getSyncState(database, "claude");
    const lastSyncAt = syncState?.lastSyncAt;
    const skipBefore =
      lastSyncAt !== undefined ? new Date(lastSyncAt).getTime() - 60 * 60 * 1000 : undefined;
    const since = options.since ?? config.since;

    const rulesPath = join(config.home, "tempad.toml");
    const rules = loadRules(rulesPath);
    const queries = prepareQueries(database);

    for (const claudeDir of config.claudeDirs) {
      const projectsGlob = new Bun.Glob("projects/*/*.jsonl");
      const files: string[] = [];
      for (const relativePath of projectsGlob.scanSync({ cwd: claudeDir })) {
        files.push(join(claudeDir, relativePath));
      }

      for (const filePath of files) {
        const stats = statSync(filePath);
        if (skipBefore !== undefined && stats.mtime.getTime() < skipBefore) continue;

        const result = await syncFile(filePath, claudeDir, config, rules, queries, since);
        sessionsInserted += result.sessionsInserted;
        sessionsUpdated += result.sessionsUpdated;
        messagesInserted += result.messagesInserted;
        warnings.push(...result.warnings);
      }
    }

    console.error(`claude: ${messagesInserted} messages inserted`);

    return {
      source: "claude",
      inserted: sessionsInserted,
      updated: sessionsUpdated,
      deleted: 0,
      warnings,
    };
  },
};
