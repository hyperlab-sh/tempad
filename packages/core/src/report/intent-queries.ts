import type { Database } from "bun:sqlite";
import { currentDeclaredQuest } from "../intent/declarations.ts";
import { stateAsOf } from "../intent/time-travel.ts";
import { localDayBoundsUtc } from "./markdown.ts";
import { clientCondition, type DateRange } from "./queries.ts";

/**
 * Intent tables (quests, stints, traces, questions) render as of a past
 * date via `--as-of`; mirrors (commits, sessions, Monday items) always read
 * current state -- see the intent-core plan. `stateAsOf` rebuilds a fresh in-memory
 * database from events up to `asOf`, so callers must query it instead of
 * `database` for anything intent-related when `asOf` is set.
 *
 * Traces resolve their org/project through a join to `claude_sessions` (see
 * `queryTraceIntervals`), so `claude_sessions` is copied into the as-of
 * database -- it holds no events of its own and would otherwise be empty.
 */
export function resolveIntentDatabase(database: Database, asOf: string | undefined): Database {
  if (!asOf) return database;
  const asOfDatabase = stateAsOf(database, asOf);

  const sessions = database.query("SELECT * FROM claude_sessions").all() as Record<
    string,
    unknown
  >[];
  if (sessions.length > 0) {
    const columns = Object.keys(sessions[0] as Record<string, unknown>);
    const insert = asOfDatabase.query(
      `INSERT INTO claude_sessions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    const insertAll = asOfDatabase.transaction(() => {
      for (const session of sessions)
        insert.run(...columns.map((column) => session[column] as never));
    });
    insertAll();
  }

  return asOfDatabase;
}

export interface StintRow {
  id: string;
  questId: string | null;
  questTitle: string | null;
  questConfirmed: boolean;
  questOriginKind: string | null;
  org: string | null;
  project: string | null;
  outcome: string;
  openedAt: string;
  closedAt: string | null;
  minutes: number;
}

export interface SideQuestRow {
  id: string;
  title: string;
  org: string | null;
  project: string | null;
  /** Outcome of the stint the side quest deviates from, when it names one. */
  fromStintOutcome: string | null;
  /** The quest it deviates from: the stint's quest, or the quest it names directly. */
  fromQuestId: string | null;
  fromQuestTitle: string | null;
  branchedAt: string;
  trigger: string | null;
  kind: string | null;
  returnedAt: string | null;
  minutes: number;
}

interface TraceIntervalRow {
  stintId: string;
  startedAt: string;
  endedAt: string;
  org: string | null;
  project: string | null;
}

function toDayBounds(range: DateRange): { start: string; end: string } {
  const fromBounds = localDayBoundsUtc(range.from, range.timeZone);
  const toBounds = localDayBoundsUtc(range.to, range.timeZone);
  return { start: fromBounds.start, end: toBounds.end };
}

/**
 * Intent projection tables are created lazily by the first event applied or
 * by `tempad rebuild` (see `src/intent/projections/index.ts`). A Hero who has
 * never used the intent layer has a database without them; reports must
 * still render, just with nothing to say about quests and stints.
 */
function hasIntentTables(database: Database): boolean {
  const row = database
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stints'")
    .get();
  return row !== null;
}

/**
 * Only current (non-superseded) trace links -- a relinked trace's time counts
 * once, under whichever stint it is linked to now, never under both.
 */
function queryTraceIntervals(database: Database, range: DateRange): TraceIntervalRow[] {
  const { start, end } = toDayBounds(range);
  const conditions = ["t.retracted_at IS NULL", "t.started_at < ?", "t.ended_at > ?"];
  const params: (string | number)[] = [end, start];

  if (range.org) {
    conditions.push("LOWER(s.org) = ?");
    params.push(range.org.toLowerCase());
  }
  if (range.project) {
    conditions.push("LOWER(s.project) = ?");
    params.push(range.project.toLowerCase());
  }

  const client = clientCondition("s.path_meta", range.client);
  if (client.param) params.push(client.param);

  return database
    .query(
      `SELECT tl.stint_id as stintId, t.started_at as startedAt, t.ended_at as endedAt,
              s.org as org, s.project as project
       FROM trace_links tl
       JOIN traces t ON t.id = tl.trace_id
       LEFT JOIN claude_sessions s ON s.id = t.session_id
       WHERE tl.superseded_at IS NULL AND ${conditions.join(" AND ")}${client.sql}
       ORDER BY t.started_at ASC`,
    )
    .all(...params) as TraceIntervalRow[];
}

/** Minutes of trace time clipped to [start, end), summed per stint id. */
function minutesByStint(
  intervals: TraceIntervalRow[],
  start: string,
  end: string,
): Map<string, number> {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const minutes = new Map<string, number>();

  for (const interval of intervals) {
    const intervalStart = Math.max(new Date(interval.startedAt).getTime(), startMs);
    const intervalEnd = Math.min(new Date(interval.endedAt).getTime(), endMs);
    if (intervalEnd <= intervalStart) continue;
    const minutesInRange = (intervalEnd - intervalStart) / 60000;
    minutes.set(interval.stintId, (minutes.get(interval.stintId) ?? 0) + minutesInRange);
  }

  return minutes;
}

/**
 * Trace start/end instants clipped to [start, end), per stint id -- the
 * evidence timestamps a quest's first/last-evidence columns are built from,
 * so they never report a time outside the report's range or a stint's
 * opened/closed_at when the trace evidence itself falls inside the range.
 */
function clippedEvidenceByStint(
  intervals: TraceIntervalRow[],
  start: string,
  end: string,
): Map<string, string[]> {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const evidence = new Map<string, string[]>();

  for (const interval of intervals) {
    const intervalStart = Math.max(new Date(interval.startedAt).getTime(), startMs);
    const intervalEnd = Math.min(new Date(interval.endedAt).getTime(), endMs);
    if (intervalEnd <= intervalStart) continue;
    const times = evidence.get(interval.stintId) ?? [];
    times.push(new Date(intervalStart).toISOString(), new Date(intervalEnd).toISOString());
    evidence.set(interval.stintId, times);
  }

  return evidence;
}

/** Org/project for a stint, taken from its earliest linked trace's session. */
function projectByStint(
  intervals: TraceIntervalRow[],
): Map<string, { org: string; project: string }> {
  const projects = new Map<string, { org: string; project: string }>();
  for (const interval of intervals) {
    if (projects.has(interval.stintId)) continue;
    if (interval.org && interval.project) {
      projects.set(interval.stintId, { org: interval.org, project: interval.project });
    }
  }
  return projects;
}

export interface StintTraceIntervalRow {
  stintId: string;
  questTitle: string | null;
  outcome: string;
  org: string | null;
  project: string | null;
  startedAt: string;
  endedAt: string;
}

/**
 * One row per trace interval (already clipped to [start, end)), with its
 * stint's quest title and outcome attached, for callers that need to
 * bucket stint time by a finer grain than a day -- the hourly report's
 * per-hour "stints active this hour" cells.
 */
export function queryStintTraceIntervals(
  database: Database,
  range: DateRange,
): StintTraceIntervalRow[] {
  if (!hasIntentTables(database)) return [];
  const { start, end } = toDayBounds(range);
  const intervals = queryTraceIntervals(database, range);
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();

  const stintIds = new Set(intervals.map((interval) => interval.stintId));
  if (stintIds.size === 0) return [];

  const stintRows = database
    .query(
      `SELECT a.id as id, a.outcome as outcome, q.title as questTitle
       FROM stints a
       LEFT JOIN quests q ON q.id = a.quest_id AND q.retracted_at IS NULL
       WHERE a.retracted_at IS NULL AND a.dismissed_at IS NULL AND a.id IN (${[...stintIds].map(() => "?").join(", ")})`,
    )
    .all(...stintIds) as { id: string; outcome: string; questTitle: string | null }[];
  const stintsById = new Map(stintRows.map((row) => [row.id, row]));

  const rows: StintTraceIntervalRow[] = [];
  for (const interval of intervals) {
    const intervalStart = Math.max(new Date(interval.startedAt).getTime(), startMs);
    const intervalEnd = Math.min(new Date(interval.endedAt).getTime(), endMs);
    if (intervalEnd <= intervalStart) continue;
    const stint = stintsById.get(interval.stintId);
    if (!stint) continue;
    rows.push({
      stintId: interval.stintId,
      questTitle: stint.questTitle,
      outcome: stint.outcome,
      org: interval.org,
      project: interval.project,
      startedAt: new Date(intervalStart).toISOString(),
      endedAt: new Date(intervalEnd).toISOString(),
    });
  }
  return rows;
}

export interface DismissedQuestMinutesRow {
  questId: string;
  questTitle: string;
  org: string | null;
  project: string | null;
  minutes: number;
}

/**
 * Trace minutes of dismissed stints (below `stint_min_minutes`), grouped by
 * quest, org and project -- the "short work" line `daily.ts`/`weekly.ts`
 * render under a quest's normal stint listing. A dismissed stint's traces
 * keep their `stint_id` and quest (see `w5/lifecycle.ts`), so this reuses the
 * same `traces -> stints -> quests` path `queryStints` uses, just scoped to
 * `dismissed_at IS NOT NULL` instead of `IS NULL`.
 */
export function queryDismissedMinutesByQuest(
  database: Database,
  range: DateRange,
): DismissedQuestMinutesRow[] {
  if (!hasIntentTables(database)) return [];
  const { start, end } = toDayBounds(range);
  const intervals = queryTraceIntervals(database, range);
  const minutes = minutesByStint(intervals, start, end);
  const projects = projectByStint(intervals);

  const stintIds = new Set(intervals.map((interval) => interval.stintId));
  if (stintIds.size === 0) return [];

  const rows = database
    .query(
      `SELECT a.id as id, a.quest_id as questId, q.title as questTitle
       FROM stints a
       JOIN quests q ON q.id = a.quest_id AND q.retracted_at IS NULL
       WHERE a.retracted_at IS NULL AND a.dismissed_at IS NOT NULL
         AND a.id IN (${[...stintIds].map(() => "?").join(", ")})`,
    )
    .all(...stintIds) as { id: string; questId: string; questTitle: string }[];

  const byQuest = new Map<string, DismissedQuestMinutesRow>();
  for (const row of rows) {
    const stintMinutes = minutes.get(row.id) ?? 0;
    if (stintMinutes <= 0) continue;
    const project = projects.get(row.id) ?? null;
    const key = `${project?.org ?? ""}/${project?.project ?? ""}/${row.questId}`;
    const existing = byQuest.get(key);
    if (existing) {
      existing.minutes += stintMinutes;
    } else {
      byQuest.set(key, {
        questId: row.questId,
        questTitle: row.questTitle,
        org: project?.org ?? null,
        project: project?.project ?? null,
        minutes: stintMinutes,
      });
    }
  }
  return [...byQuest.values()];
}

export function queryStints(database: Database, range: DateRange): StintRow[] {
  if (!hasIntentTables(database)) return [];
  const { start, end } = toDayBounds(range);
  const intervals = queryTraceIntervals(database, range);
  const minutes = minutesByStint(intervals, start, end);
  const projects = projectByStint(intervals);

  const stintIds = new Set(intervals.map((interval) => interval.stintId));
  if (stintIds.size === 0) return [];

  const rows = database
    .query(
      `SELECT a.id as id, a.quest_id as questId, a.outcome as outcome,
              a.opened_at as openedAt, a.closed_at as closedAt,
              q.title as questTitle, q.confirmed as questConfirmed, q.origin_kind as questOriginKind
       FROM stints a
       LEFT JOIN quests q ON q.id = a.quest_id AND q.retracted_at IS NULL
       WHERE a.retracted_at IS NULL AND a.dismissed_at IS NULL AND a.id IN (${[...stintIds].map(() => "?").join(", ")})`,
    )
    .all(...stintIds) as {
    id: string;
    questId: string | null;
    outcome: string;
    openedAt: string;
    closedAt: string | null;
    questTitle: string | null;
    questConfirmed: number | null;
    questOriginKind: string | null;
  }[];

  return rows
    .map((row) => {
      const project = projects.get(row.id) ?? null;
      return {
        id: row.id,
        questId: row.questId,
        questTitle: row.questTitle,
        questConfirmed: row.questConfirmed === 1,
        questOriginKind: row.questOriginKind,
        org: project?.org ?? null,
        project: project?.project ?? null,
        outcome: row.outcome,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        minutes: minutes.get(row.id) ?? 0,
      };
    })
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

export function querySideQuests(database: Database, range: DateRange): SideQuestRow[] {
  if (!hasIntentTables(database)) return [];
  const { start, end } = toDayBounds(range);
  const intervals = queryTraceIntervals(database, range);
  const minutesByQuestStint = minutesByStint(intervals, start, end);
  const projects = projectByStint(intervals);

  const conditions = [
    "q.retracted_at IS NULL",
    "q.branched_at IS NOT NULL",
    "q.branched_at >= ?",
    "q.branched_at < ?",
  ];
  const params: (string | number)[] = [start, end];

  const rows = database
    .query(
      `SELECT q.id as id, q.title as title, q.branched_at as branchedAt, q.trigger as trigger,
              q.branch_kind as kind, q.returned_at as returnedAt,
              (SELECT a.outcome FROM stints a WHERE a.id = q.deviates_from_stint_id) as fromStintOutcome,
              parent.id as fromQuestId, parent.title as fromQuestTitle
       FROM quests q
       LEFT JOIN quests parent ON parent.id = COALESCE(
         q.deviates_from_quest_id,
         (SELECT a.quest_id FROM stints a WHERE a.id = q.deviates_from_stint_id))
       WHERE ${conditions.join(" AND ")}
       ORDER BY q.branched_at ASC`,
    )
    .all(...params) as {
    id: string;
    title: string;
    branchedAt: string;
    trigger: string | null;
    kind: string | null;
    returnedAt: string | null;
    fromStintOutcome: string | null;
    fromQuestId: string | null;
    fromQuestTitle: string | null;
  }[];

  return rows.map((row) => {
    const questStints = database
      .query(
        "SELECT id FROM stints WHERE quest_id = ? AND retracted_at IS NULL AND dismissed_at IS NULL",
      )
      .all(row.id) as { id: string }[];

    let minutes = 0;
    let project: { org: string; project: string } | null = null;
    for (const stint of questStints) {
      minutes += minutesByQuestStint.get(stint.id) ?? 0;
      project ??= projects.get(stint.id) ?? null;
    }

    return {
      id: row.id,
      title: row.title,
      org: project?.org ?? null,
      project: project?.project ?? null,
      fromStintOutcome: row.fromStintOutcome,
      fromQuestId: row.fromQuestId,
      fromQuestTitle: row.fromQuestTitle,
      branchedAt: row.branchedAt,
      trigger: row.trigger,
      kind: row.kind,
      returnedAt: row.returnedAt,
      minutes,
    };
  });
}

export interface QuestSummaryRow {
  id: string;
  title: string;
  confirmed: boolean;
  originKind: string;
  state: string;
  org: string | null;
  project: string | null;
  firstEvidence: string;
  lastEvidence: string;
  stints: number;
  sideQuestMinutes: number;
}

/**
 * One row per quest with a stint touched in range (a linked trace
 * started or ended in range), for the project report's quest table.
 * `commits`/`sessions` are not counted here -- quests carry no direct link
 * to `gh_commits`/`claude_sessions` rows, only to traces, which the caller
 * already has by org/project from `queryCommits`/`querySessions`.
 */
export function queryQuests(database: Database, range: DateRange): QuestSummaryRow[] {
  if (!hasIntentTables(database)) return [];
  const { start, end } = toDayBounds(range);
  const intervals = queryTraceIntervals(database, range);
  const projects = projectByStint(intervals);
  const evidenceByStint = clippedEvidenceByStint(intervals, start, end);

  const stintIds = new Set(intervals.map((interval) => interval.stintId));
  if (stintIds.size === 0) return [];

  const stintRows = database
    .query(
      `SELECT id, quest_id as questId FROM stints WHERE retracted_at IS NULL AND dismissed_at IS NULL AND id IN (${[
        ...stintIds,
      ]
        .map(() => "?")
        .join(", ")})`,
    )
    .all(...stintIds) as { id: string; questId: string | null }[];

  const questIds = new Set(
    stintRows.map((row) => row.questId).filter((id): id is string => id !== null),
  );
  if (questIds.size === 0) return [];

  const questRows = database
    .query(
      `SELECT id, title, confirmed, state, origin_kind as originKind FROM quests WHERE retracted_at IS NULL AND id IN (${[
        ...questIds,
      ]
        .map(() => "?")
        .join(", ")})`,
    )
    .all(...questIds) as {
    id: string;
    title: string;
    confirmed: number;
    state: string;
    originKind: string;
  }[];

  const sideQuestMinutesByQuestId = new Map<string, number>();
  for (const sideQuest of querySideQuests(database, range)) {
    const parentId = sideQuest.fromQuestId;
    if (!parentId) continue;
    sideQuestMinutesByQuestId.set(
      parentId,
      (sideQuestMinutesByQuestId.get(parentId) ?? 0) + sideQuest.minutes,
    );
  }

  return questRows
    .map((quest) => {
      const questStints = stintRows.filter((row) => row.questId === quest.id);
      const evidenceTimes = questStints.flatMap((row) => evidenceByStint.get(row.id) ?? []);
      // A quest's stint can match `queryTraceIntervals`' SQL range (which
      // compares raw trace start/end) yet clip to nothing once bounded to
      // [start, end) -- e.g. a trace that only brushes the range's edge.
      // Such a quest has no evidence to report and is dropped rather than
      // crashing `reduce` with no initial value.
      if (evidenceTimes.length === 0) return null;
      const firstEvidence = evidenceTimes.reduce(
        (min, time) => (time < min ? time : min),
        evidenceTimes[0] as string,
      );
      const lastEvidence = evidenceTimes.reduce(
        (max, time) => (time > max ? time : max),
        evidenceTimes[0] as string,
      );

      let project: { org: string; project: string } | null = null;
      for (const stint of questStints) {
        project ??= projects.get(stint.id) ?? null;
      }

      return {
        id: quest.id,
        title: quest.title,
        confirmed: quest.confirmed === 1,
        originKind: quest.originKind,
        state: quest.state,
        org: project?.org ?? null,
        project: project?.project ?? null,
        firstEvidence,
        lastEvidence,
        stints: questStints.length,
        sideQuestMinutes: sideQuestMinutesByQuestId.get(quest.id) ?? 0,
      };
    })
    .filter((quest): quest is QuestSummaryRow => quest !== null);
}

/**
 * Traces `tempad review` will surface: those attached to an expired question,
 * or classified with zero confidence (the model dropped them per spec's error
 * handling). Counted per range/org/project by the trace's recorded session.
 */
export function queryOpenQuestions(database: Database, range: DateRange): number {
  if (!hasIntentTables(database)) return 0;
  const { start, end } = toDayBounds(range);
  const conditions = ["t.retracted_at IS NULL", "t.recorded_at >= ?", "t.recorded_at < ?"];
  const params: (string | number)[] = [start, end];

  if (range.org) {
    conditions.push("LOWER(s.org) = ?");
    params.push(range.org.toLowerCase());
  }
  if (range.project) {
    conditions.push("LOWER(s.project) = ?");
    params.push(range.project.toLowerCase());
  }

  const client = clientCondition("s.path_meta", range.client);
  if (client.param) params.push(client.param);

  const row = database
    .query(
      `SELECT COUNT(DISTINCT t.id) as count
       FROM traces t
       LEFT JOIN claude_sessions s ON s.id = t.session_id
       LEFT JOIN questions qu ON qu.trace_id = t.id
       WHERE ${conditions.join(" AND ")}${client.sql}
         AND (t.confidence = 0 OR qu.state = 'expired')`,
    )
    .get(...params) as { count: number };
  return row.count;
}

export interface NonClaudeEvidenceRow {
  id: string;
  kind: "commit" | "monday_item";
  questId: string | null;
  questTitle: string | null;
}

/**
 * Attributes each `gh_commits`/`monday_items` row in range to a quest by
 * finding the `claude_sessions` row in the same org/project whose
 * `[started_at, ended_at]` window overlaps the row's timestamp, then
 * resolving that session's current declared quest as of the timestamp. When
 * more than one session overlaps, the one with the latest `started_at` wins
 * -- a heuristic ("most recently started session is presumed active"), not
 * a guarantee. A commit/item with no overlapping session, or whose session
 * has no declaration at that timestamp, comes back unattributed
 * (`questId: null`) -- never invented. Read-only: writes nothing back.
 */
export function attributeNonClaudeEvidence(
  database: Database,
  range: DateRange,
): NonClaudeEvidenceRow[] {
  const { start, end } = toDayBounds(range);
  const rows: NonClaudeEvidenceRow[] = [];

  const commitRows = database
    .query(
      `SELECT c.sha as id, r.org as org, r.project as project, c.authored_at as at
       FROM gh_commits c
       JOIN gh_repos r ON r.full_name = c.repo
       WHERE c.authored_at >= ? AND c.authored_at < ?`,
    )
    .all(start, end) as { id: string; org: string | null; project: string | null; at: string }[];

  const mondayRows = database
    .query(
      `SELECT CAST(id AS TEXT) as id, org as org, project as project, updated_at as at
       FROM monday_items
       WHERE updated_at >= ? AND updated_at < ?`,
    )
    .all(start, end) as { id: string; org: string | null; project: string | null; at: string }[];

  const attribute = (
    id: string,
    kind: "commit" | "monday_item",
    org: string | null,
    project: string | null,
    at: string,
  ): NonClaudeEvidenceRow => {
    if (!org || !project) return { id, kind, questId: null, questTitle: null };

    const session = database
      .query(
        `SELECT id FROM claude_sessions
         WHERE org = ? AND project = ? AND started_at <= ? AND ended_at >= ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(org, project, at, at) as { id: string } | null;
    if (!session) return { id, kind, questId: null, questTitle: null };

    const declared = currentDeclaredQuest(database, { sessionId: session.id, at });
    if (!declared) return { id, kind, questId: null, questTitle: null };

    return { id, kind, questId: declared.questId, questTitle: declared.title };
  };

  for (const row of commitRows) {
    rows.push(attribute(row.id, "commit", row.org, row.project, row.at));
  }
  for (const row of mondayRows) {
    rows.push(attribute(row.id, "monday_item", row.org, row.project, row.at));
  }

  return rows;
}

export interface DoubtRow {
  id: string;
  org: string | null;
  project: string | null;
}

/**
 * One row per doubt (`belongs`-kind question) tied to a trace/session in
 * range, with the org/project it belongs to -- lets a caller like
 * `weekly.ts` fetch once per day and filter per project key in-memory, the
 * same way it already does for `queryActivities`/`queryQuests`/`querySideQuests`,
 * instead of re-querying per (day x project) pair.
 */
export function queryDoubtRows(database: Database, range: DateRange): DoubtRow[] {
  if (!hasIntentTables(database)) return [];
  const { start, end } = toDayBounds(range);
  const conditions = [
    "qu.kind = 'belongs'",
    "t.retracted_at IS NULL",
    "t.started_at >= ?",
    "t.started_at < ?",
  ];
  const params: (string | number)[] = [start, end];

  const client = clientCondition("s.path_meta", range.client);
  if (client.param) params.push(client.param);

  return database
    .query(
      `SELECT DISTINCT qu.id as id, s.org as org, s.project as project
       FROM questions qu
       JOIN traces t ON t.id = qu.trace_id
       LEFT JOIN claude_sessions s ON s.id = t.session_id
       WHERE ${conditions.join(" AND ")}${client.sql}`,
    )
    .all(...params) as DoubtRow[];
}

/**
 * Doubts (`belongs: false` verifier segments recorded as `belongs`-kind
 * questions) tied to a trace/session in range, scoped by org/project/client
 * the same way `queryTraceIntervals` scopes traces.
 */
export function querySideQuestDoubts(database: Database, range: DateRange): number {
  const rows = queryDoubtRows(database, range);
  const org = range.org?.toLowerCase();
  const project = range.project?.toLowerCase();
  return rows.filter(
    (row) =>
      (!org || row.org?.toLowerCase() === org) &&
      (!project || row.project?.toLowerCase() === project),
  ).length;
}
