import type { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import type { IntentConfig } from "../intent/config";
import { usageText } from "../usage";
import { cliSessionKindClassifier, type SessionKindClassifier } from "./classifier";
import {
  effectiveSessionKind,
  ensureSessionKindTables,
  type RefreshSessionKindsResult,
  refreshSessionKinds,
  setSessionKind,
} from "./kind";
import { isSessionKind } from "./kinds";

export interface SessionsContext {
  database: Database;
  home: string;
  intentConfig: IntentConfig;
  /** This host's slug when push sync is on: only its sessions go to the model. */
  hostSlug?: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Overrides the `claude -p` classifier (tests). */
  classifier?: SessionKindClassifier | null;
}

const SESSIONS_DEFAULT_DAYS = 7;

/** The `claude -p` classifier `[w5]` describes, or null when `session_kind_batch` is 0. */
export function buildSessionKindClassifier(
  home: string,
  intentConfig: IntentConfig,
): SessionKindClassifier | null {
  const w5 = intentConfig.w5;
  if (w5.sessionKindBatch === 0) return null;
  return cliSessionKindClassifier({
    model: w5.sessionKindModel,
    command: w5.claudeCommand,
    // Like the w5 classifier: no project CLAUDE.md or hooks reach the call.
    cwd: home,
    timeoutMs: w5.timeoutSeconds * 1000,
  });
}

export function formatSessionKindSummary(result: RefreshSessionKindsResult): string {
  return `sessions: kinds ruled=${result.ruled} cleared=${result.cleared} modeled=${result.modeled} failed=${result.failed} pending=${result.pending}`;
}

/**
 * The pass `tempad sync` runs after collecting Claude sessions. It never fails
 * the sync: a failure is one line on stderr.
 */
export async function runSessionKindPass(context: SessionsContext): Promise<void> {
  try {
    const result = await refreshSessionKinds(context.database, {
      classifier:
        context.classifier !== undefined
          ? context.classifier
          : buildSessionKindClassifier(context.home, context.intentConfig),
      model: context.intentConfig.w5.sessionKindModel,
      modelLimit: context.intentConfig.w5.sessionKindBatch,
      hostSlug: context.hostSlug,
      log: context.stderr,
    });
    context.stdout(formatSessionKindSummary(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.stderr(`sessions: kind pass failed: ${message}`);
  }
}

export async function runSessionsCommand(
  args: string[],
  context: SessionsContext,
): Promise<number> {
  if (args[0] === "kind") return runKind(args.slice(1), context);
  return runList(args, context);
}

function runList(args: string[], context: SessionsContext): number {
  const usage = `usage: ${usageText("sessions")}`;
  let values: { days?: string; kind?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: { days: { type: "string" }, kind: { type: "string" } },
      strict: true,
    }));
  } catch {
    context.stderr(usage);
    return 2;
  }
  if (values.days !== undefined && !/^[1-9]\d*$/.test(values.days)) {
    context.stderr(usage);
    return 2;
  }
  if (values.kind !== undefined && !isSessionKind(values.kind)) {
    context.stderr(usage);
    return 2;
  }
  const days = values.days === undefined ? SESSIONS_DEFAULT_DAYS : Number(values.days);
  // `Date.now() - days * 86400000` must stay a real instant: an absurd `--days`
  // (a 20-digit string parses to a float) would throw a RangeError from
  // `toISOString` instead of answering with usage.
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  if (
    !Number.isSafeInteger(days) ||
    !Number.isSafeInteger(sinceMs) ||
    Math.abs(sinceMs) > 8.64e15
  ) {
    context.stderr(usage);
    return 2;
  }
  const since = new Date(sinceMs).toISOString();
  ensureSessionKindTables(context.database);
  // The effective kind is manual, then rule, then model (see
  // intent/projections/session-kind.ts); one subquery per column picks it.
  const rows = context.database
    .query(
      `SELECT s.id, s.started_at, s.org, s.project, s.title,
              (SELECT kind FROM session_kind WHERE session_id = s.id
                 ORDER BY CASE origin WHEN 'manual' THEN 0 WHEN 'rule' THEN 1 ELSE 2 END LIMIT 1) AS effective_kind,
              (SELECT source FROM session_kind WHERE session_id = s.id
                 ORDER BY CASE origin WHEN 'manual' THEN 0 WHEN 'rule' THEN 1 ELSE 2 END LIMIT 1) AS effective_source
       FROM claude_sessions s
       WHERE s.started_at >= ?
       ORDER BY s.started_at DESC`,
    )
    .all(since) as {
    id: string;
    started_at: string;
    org: string;
    project: string;
    title: string | null;
    effective_kind: string | null;
    effective_source: string | null;
  }[];
  for (const row of rows) {
    const kind = row.effective_kind;
    if (values.kind !== undefined && kind !== values.kind) continue;
    context.stdout(
      `${row.started_at}  ${row.id}  ${kind ?? "unknown"} (${row.effective_source ?? "-"})  ${row.org}/${row.project}  ${row.title ?? ""}`.trimEnd(),
    );
  }
  return 0;
}

async function runKind(args: string[], context: SessionsContext): Promise<number> {
  const usage = `usage: ${usageText("sessions kind")}`;
  let parsed: {
    values: { set?: string; clear?: boolean; refresh?: boolean; limit?: string };
    positionals: string[];
  };
  try {
    parsed = parseArgs({
      args,
      options: {
        set: { type: "string" },
        clear: { type: "boolean" },
        refresh: { type: "boolean" },
        limit: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    context.stderr(usage);
    return 2;
  }
  const { values, positionals } = parsed;
  const sessionId = positionals[0];

  if (values.refresh) {
    if (sessionId !== undefined || values.set !== undefined || values.clear) {
      context.stderr(usage);
      return 2;
    }
    if (values.limit !== undefined && !/^\d+$/.test(values.limit)) {
      context.stderr(usage);
      return 2;
    }
    const limit =
      values.limit === undefined ? context.intentConfig.w5.sessionKindBatch : Number(values.limit);
    const result = await refreshSessionKinds(context.database, {
      classifier:
        limit === 0
          ? null
          : context.classifier !== undefined
            ? context.classifier
            : buildSessionKindClassifier(context.home, {
                ...context.intentConfig,
                w5: { ...context.intentConfig.w5, sessionKindBatch: limit },
              }),
      model: context.intentConfig.w5.sessionKindModel,
      modelLimit: limit,
      hostSlug: context.hostSlug,
      log: context.stderr,
    });
    context.stdout(formatSessionKindSummary(result));
    return 0;
  }

  if (sessionId === undefined || values.limit !== undefined) {
    context.stderr(usage);
    return 2;
  }
  if (values.set !== undefined && values.clear) {
    context.stderr(usage);
    return 2;
  }
  if (values.set !== undefined && !isSessionKind(values.set)) {
    context.stderr(usage);
    return 2;
  }
  const known = context.database.query("SELECT 1 FROM claude_sessions WHERE id = ?").get(sessionId);
  if (known === null) {
    context.stderr(`unknown claude session: ${sessionId}; run tempad sync claude first`);
    return 1;
  }

  if (values.set !== undefined && isSessionKind(values.set)) {
    setSessionKind(context.database, sessionId, values.set);
  } else if (values.clear) {
    const current = effectiveSessionKind(context.database, sessionId);
    if (current?.source !== "manual") {
      context.stderr(`session ${sessionId} has no manual kind; nothing to clear`);
      return 1;
    }
    setSessionKind(context.database, sessionId, null);
  }

  const kind = effectiveSessionKind(context.database, sessionId);
  context.stdout(
    kind === null
      ? `${sessionId} unknown (not classified yet)`
      : `${sessionId} ${kind.kind} source=${kind.source} confidence=${kind.confidence}`,
  );
  return 0;
}
