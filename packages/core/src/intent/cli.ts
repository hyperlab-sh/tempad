import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { HomeConfig } from "../config/env";
import { answerQuestion, assignStint, stateImpact, THEME_PATTERN } from "./api";
import type { IntentConfig } from "./config";
import {
  activeDeclaredQuests,
  type BranchKind,
  type Commitment,
  declareQuest,
} from "./declarations";
import { assertEditIntent } from "./edit-intent";
import { EVIDENCE_REF_SHAPES, formatEvidenceRef, parseEvidenceRef } from "./evidence-ref";
import { currentHeroId } from "./identity";
import { newUlid } from "./ids";
import { applyIncremental, ensureTables, rebuildAll } from "./projections";
import { openMembershipOriginals } from "./projections/party";
import { resolveQuest } from "./projections/quest";
import { registerAllProjections } from "./projections/register";
import { EventStore } from "./store";
import { stateAsOf } from "./time-travel";

registerAllProjections();

export interface IntentContext {
  database: Database;
  config: HomeConfig;
  intentConfig: IntentConfig;
  stdout: (line: string) => void;
}

function requireHero(database: Database): string {
  const id = currentHeroId(database);
  if (!id) throw new Error("run `tempad hero init` first");
  return id;
}

function findPartyBySlug(database: Database, slug: string): { id: string } | null {
  return database.query("SELECT id FROM parties WHERE slug = ?").get(slug) as { id: string } | null;
}

function resolveOwner(database: Database, owner: string): { kind: "hero" | "party"; id: string } {
  if (owner === "hero") {
    return { kind: "hero", id: requireHero(database) };
  }
  if (owner.startsWith("party:")) {
    const slug = owner.slice("party:".length);
    const party = findPartyBySlug(database, slug);
    if (!party) throw new Error(`unknown party: ${slug}`);
    return { kind: "party", id: party.id };
  }
  throw new Error(`invalid --owner: ${owner}`);
}

function runHeroCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "init") {
    const name = rest[0];
    if (!name) {
      console.error('usage: tempad hero init "<name>"');
      return 2;
    }
    const existing = currentHeroId(context.database);
    if (existing) {
      console.error("hero already exists");
      return 1;
    }
    const store = new EventStore(context.database);
    const event = store.append({
      actor: "hero",
      kind: "hero.created",
      subject: newUlid(),
      payload: { name },
    });
    applyIncremental(context.database, event);
    return 0;
  }
  console.error('usage: tempad hero init "<name>"');
  return 2;
}

function runPartyCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  const store = new EventStore(context.database);

  if (subcommand === "add") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { joined: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const [slug, name] = positionals;
    if (!slug || !name) {
      console.error('usage: tempad party add <slug> "<name>" [--joined YYYY-MM-DD]');
      return 2;
    }
    if (findPartyBySlug(context.database, slug)) {
      console.error(`party already exists: ${slug}`);
      return 1;
    }
    const heroId = requireHero(context.database);
    const partyId = newUlid();
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "party.created",
        subject: partyId,
        payload: { slug, name },
      }),
    );
    const joined = values.joined ? `${values.joined}T00:00:00.000Z` : undefined;
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "membership.joined",
        subject: newUlid(),
        payload: { hero: heroId, party: partyId, joined },
        at: joined,
      }),
    );
    return 0;
  }

  if (subcommand === "leave") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const slug = positionals[0];
    if (!slug) {
      console.error('usage: tempad party leave <slug> --reason "..."');
      return 2;
    }
    const party = findPartyBySlug(context.database, slug);
    if (!party) {
      console.error(`unknown party: ${slug}`);
      return 1;
    }
    const heroId = requireHero(context.database);
    const membership = context.database
      .query("SELECT id FROM memberships WHERE hero_id = ? AND party_id = ? AND left_at IS NULL")
      .get(heroId, party.id) as { id: string } | null;
    if (!membership) {
      console.error(`hero is not a member of ${slug}`);
      return 1;
    }
    // After a sync the hero's membership can stand for several joins (one per
    // host that ran `party add`), and a leave ends only the join it names, so
    // leaving the party means ending each one still open. On a single host
    // there is exactly one.
    for (const original of openMembershipOriginals(context.database, membership.id)) {
      applyIncremental(
        context.database,
        store.append({
          actor: "hero",
          kind: "membership.left",
          subject: original,
          payload: { reason: values.reason },
        }),
      );
    }
    return 0;
  }

  if (subcommand === "list") {
    const rows = context.database.query("SELECT slug, name FROM parties ORDER BY name").all() as {
      slug: string;
      name: string;
    }[];
    for (const row of rows) context.stdout(`${row.slug}  ${row.name}`);
    return 0;
  }

  console.error("usage: tempad party add|leave|list ...");
  return 2;
}

function runClientCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    const [slug, name] = rest;
    if (!slug || !name) {
      console.error('usage: tempad client add <slug> "<name>"');
      return 2;
    }
    const existing = context.database.query("SELECT id FROM clients WHERE slug = ?").get(slug);
    if (existing) {
      console.error(`client already exists: ${slug}`);
      return 1;
    }
    const store = new EventStore(context.database);
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "client.created",
        subject: newUlid(),
        payload: { slug, name },
      }),
    );
    return 0;
  }
  console.error('usage: tempad client add <slug> "<name>"');
  return 2;
}

function parseOwnerFlag(
  database: Database,
  values: Record<string, unknown>,
): { kind: "hero" | "party"; id: string } {
  const owner = values.owner;
  if (typeof owner !== "string") throw new Error("--owner is required (hero or party:<slug>)");
  return resolveOwner(database, owner);
}

function runSagaCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  const store = new EventStore(context.database);

  if (subcommand === "add") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { owner: { type: "string" }, statement: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const title = positionals[0];
    if (!title) {
      console.error(
        'usage: tempad saga add --owner hero|party:<slug> "<title>" [--statement "..."]',
      );
      return 2;
    }
    const owner = parseOwnerFlag(context.database, values);
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "saga.created",
        subject: newUlid(),
        payload: { owner, title, statement: values.statement },
      }),
    );
    return 0;
  }

  if (subcommand === "reword") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { statement: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const [id, title] = positionals;
    if (!id || !title) {
      console.error('usage: tempad saga reword <id> "<title>" [--statement]');
      return 2;
    }
    assertEditIntent(context.database, "saga", id, "reword");
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "saga.reworded",
        subject: id,
        payload: { title, statement: values.statement },
      }),
    );
    return 0;
  }

  if (subcommand === "replace") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { statement: { type: "string" }, reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const [id, title] = positionals;
    if (!id || !title || !values.reason) {
      console.error('usage: tempad saga replace <id> "<title>" [--statement] --reason "..."');
      return 2;
    }
    const old = context.database
      .query("SELECT owner_kind, owner_id FROM sagas WHERE id = ?")
      .get(id) as { owner_kind: "hero" | "party"; owner_id: string } | null;
    if (!old) {
      console.error(`unknown saga: `);
      return 1;
    }
    assertEditIntent(context.database, "saga", id, "replace");
    const newId = newUlid();
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "saga.created",
        subject: newId,
        payload: {
          owner: { kind: old.owner_kind, id: old.owner_id },
          title,
          statement: values.statement,
        },
      }),
    );
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "saga.ended",
        subject: id,
        payload: { reason: "replaced", replaced_by: newId, note: values.reason },
      }),
    );
    return 0;
  }

  if (subcommand === "end") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.reason) {
      console.error("usage: tempad saga end <id> --reason achieved|abandoned");
      return 2;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "saga.ended",
        subject: id,
        payload: { reason: values.reason },
      }),
    );
    return 0;
  }

  if (subcommand === "edit") {
    const [id, title] = rest;
    if (!id || !title) {
      console.error('usage: tempad saga edit <id> "<title>"');
      return 2;
    }
    assertEditIntent(context.database, "saga", id, undefined);
    applyIncremental(
      context.database,
      store.append({ actor: "hero", kind: "saga.reworded", subject: id, payload: { title } }),
    );
    return 0;
  }

  if (subcommand === "list") {
    const { values } = parseArgs({
      args: rest,
      options: { all: { type: "boolean", default: false }, "as-of": { type: "string" } },
      strict: true,
    });
    const source = values["as-of"]
      ? stateAsOf(context.database, values["as-of"])
      : context.database;
    const where = values.all ? "" : "WHERE ended_at IS NULL";
    const rows = source
      .query(`SELECT id, title, owner_kind, end_reason FROM sagas ${where} ORDER BY created_at`)
      .all() as {
      id: string;
      title: string;
      owner_kind: string;
      end_reason: string | null;
    }[];
    for (const row of rows) {
      const suffix = row.end_reason ? ` [ended ${row.end_reason}]` : "";
      context.stdout(`${row.id}  ${row.title}  (${row.owner_kind})${suffix}`);
    }
    return 0;
  }

  console.error("usage: tempad saga add|reword|replace|end|edit|list ...");
  return 2;
}

function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(h|m)$/.exec(raw);
  if (!match?.[1] || !match[2]) throw new Error(`invalid --budget: ${raw} (expected Nh or Nm)`);
  const amount = Number.parseInt(match[1], 10);
  return match[2] === "h" ? amount * 60 : amount;
}

function findQuest(
  database: Database,
  id: string,
): { owner_kind: string; owner_id: string } | null {
  return database.query("SELECT owner_kind, owner_id FROM quests WHERE id = ?").get(id) as {
    owner_kind: string;
    owner_id: string;
  } | null;
}

function questExists(database: Database, id: string): boolean {
  return database.query("SELECT 1 FROM quests WHERE id = ?").get(id) !== null;
}

/** True when a `retracted` event has hidden the quest. A missing quest is not retracted. */
function questRetracted(database: Database, id: string): boolean {
  const row = database.query("SELECT retracted_at FROM quests WHERE id = ?").get(id) as {
    retracted_at: string | null;
  } | null;
  return row !== null && row.retracted_at !== null;
}

/**
 * Resolves a possibly-merged quest id and confirms the underlying quest exists
 * and is not retracted. A retracted quest is gone for every command that
 * targets one (confirm, merge, branch, return, lifecycle, declare); only
 * `quest retract` itself looks at retracted rows. A null result is explained
 * by `unavailableQuestMessage`.
 */
function resolveExistingQuest(database: Database, id: string): string | null {
  const resolved = resolveQuest(database, id);
  if (!questExists(database, resolved)) return null;
  return questRetracted(database, resolved) ? null : resolved;
}

/** Why `resolveExistingQuest(database, id)` returned null: retracted, or never existed. */
function unavailableQuestMessage(database: Database, id: string): string {
  const resolved = resolveQuest(database, id);
  return questRetracted(database, resolved)
    ? `quest ${resolved} is retracted`
    : `unknown quest ${id}`;
}

/** Guard for commands that take a quest id without resolving it: a retracted quest cannot be edited. */
function refuseRetractedQuest(database: Database, id: string): boolean {
  if (!questRetracted(database, id)) return false;
  console.error(`quest ${id} is retracted`);
  return true;
}

interface QuestDependents {
  /** Live stints attached to the quest, dismissed ones included (their traces still count as short work). */
  stints: string[];
  /** Live traces of those stints. */
  traces: string[];
  /** Live quests that serve, advance or deviate from this one, or were merged into it. */
  childQuests: string[];
  /** The quest this one was merged into, if any. */
  mergedInto: string | null;
}

/**
 * Everything live that hangs off a quest. Child quests are found three ways:
 * a side quest branched from one of its stints (`deviates_from_stint_id` of the
 * child names a stint of this quest; the declare path writes the pair inverted,
 * on the parent's row and naming the child's quest id, handled separately),
 * `serves`, and `advances`, which
 * has no column and lives only on the `quest.created` payload. Quests merged
 * into it count as children too.
 */
function questDependents(database: Database, id: string): QuestDependents {
  const stints = (
    database
      .query("SELECT id FROM stints WHERE quest_id = ? AND retracted_at IS NULL ORDER BY opened_at")
      .all(id) as { id: string }[]
  ).map((row) => row.id);
  const traces = stints.flatMap((stintId) =>
    (
      database
        .query("SELECT id FROM traces WHERE stint_id = ? AND retracted_at IS NULL ORDER BY id")
        .all(stintId) as { id: string }[]
    ).map((row) => row.id),
  );
  const children = new Set<string>();
  const collect = (rows: { id: string }[]) => {
    for (const row of rows) if (row.id !== id) children.add(row.id);
  };
  collect(
    database
      .query(
        `SELECT id FROM quests
          WHERE retracted_at IS NULL
            AND (serves = ? OR merged_into = ?
                 OR deviates_from_stint_id IN (SELECT id FROM stints WHERE quest_id = ?))`,
      )
      .all(id, id, id) as { id: string }[],
  );
  // `quest declare --new Y --deviates-from X` stores the pair the wrong way
  // round: X's row gets `deviates_from_stint_id = Y` (a quest id, not a stint
  // id). So when a quest's own column names a live quest, that quest is its
  // child, never its parent. The reverse lookup (`deviates_from_stint_id = id`)
  // would make X a child of Y and `--force` on Y would retract X.
  collect(
    database
      .query(
        `SELECT child.id AS id FROM quests AS parent
           JOIN quests AS child ON child.id = parent.deviates_from_stint_id
          WHERE parent.id = ? AND child.retracted_at IS NULL`,
      )
      .all(id) as { id: string }[],
  );
  collect(
    database
      .query(
        `SELECT quests.id AS id FROM quests
           JOIN events ON events.kind = 'quest.created' AND events.subject = quests.id
          WHERE quests.retracted_at IS NULL AND json_extract(events.payload, '$.advances') = ?`,
      )
      .all(id) as { id: string }[],
  );
  const merged = database.query("SELECT merged_into FROM quests WHERE id = ?").get(id) as {
    merged_into: string | null;
  } | null;
  return {
    stints,
    traces,
    childQuests: [...children].sort(),
    mergedInto: merged?.merged_into ?? null,
  };
}

/** The quest plus every child quest reachable through `questDependents`, parent first. */
function questClosure(database: Database, id: string): string[] {
  const order = [id];
  const seen = new Set(order);
  for (let index = 0; index < order.length; index += 1) {
    for (const child of questDependents(database, order[index] as string).childQuests) {
      if (seen.has(child)) continue;
      seen.add(child);
      order.push(child);
    }
  }
  return order;
}

function describeDependents(id: string, dependents: QuestDependents): string {
  const parts: string[] = [];
  if (dependents.stints.length > 0) parts.push(`${dependents.stints.length} live stints`);
  if (dependents.traces.length > 0) parts.push(`${dependents.traces.length} live traces`);
  if (dependents.childQuests.length > 0) {
    parts.push(
      `child quests (serve, advance, deviate or merged into it): ${dependents.childQuests.join(", ")}`,
    );
  }
  if (dependents.mergedInto !== null) parts.push(`it was merged into ${dependents.mergedInto}`);
  return `quest ${id} cannot be retracted: ${parts.join("; ")}. Pass --force to retract the dependents too, or use abandon if the work was dropped rather than created by mistake.`;
}

/** Appends a `retracted` event for one row (quest, stint or trace) and updates the projection. */
function retractRow(store: EventStore, database: Database, subject: string, reason: string): void {
  applyIncremental(
    database,
    store.append({
      actor: "hero",
      kind: "retracted",
      subject,
      payload: { retracts: subject, reason },
    }),
  );
}

/** Expires every question still watching or waiting for an answer about a (retracted) trace. */
function expirePendingQuestions(store: EventStore, database: Database, traceId: string): void {
  const pending = database
    .query("SELECT id FROM questions WHERE trace_id = ? AND state IN ('watching', 'asked')")
    .all(traceId) as { id: string }[];
  for (const question of pending) {
    applyIncremental(
      database,
      store.append({ actor: "hero", kind: "question.expired", subject: question.id, payload: {} }),
    );
  }
}

export const QUEST_DECLARE_OPTIONS = {
  session: { type: "string" },
  parent: { type: "string" },
  quest: { type: "string" },
  new: { type: "string" },
  outcome: { type: "string" },
  commitment: { type: "string", default: "personal" },
  project: { type: "string" },
  origin: { type: "string" },
  trigger: { type: "string" },
  kind: { type: "string" },
  plan: { type: "string" },
  done: { type: "string" },
  by: { type: "string", default: "agent" },
  at: { type: "string" },
  serves: { type: "string" },
  advances: { type: "string" },
  "deviates-from": { type: "string" },
} as const;

function runQuestCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  const store = new EventStore(context.database);

  if (subcommand === "add") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        owner: { type: "string" },
        serves: { type: "string" },
        outcome: { type: "string" },
        done: { type: "string" },
        due: { type: "string" },
        budget: { type: "string" },
        commitment: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    const title = positionals[0];
    if (!title) {
      console.error(
        'usage: tempad quest add --owner hero|party:<slug> [--serves <id>] "<title>" ...',
      );
      return 2;
    }
    const owner = parseOwnerFlag(context.database, values);
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: newUlid(),
        payload: {
          owner,
          serves: values.serves,
          title,
          outcome: values.outcome,
          done_condition: values.done,
          due: values.due,
          budget_minutes: parseBudget(values.budget),
          commitment: values.commitment,
          confirmed: true,
          origin_kind: "declared",
        },
      }),
    );
    return 0;
  }

  if (subcommand === "reword") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { outcome: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const [id, title] = positionals;
    if (!id || !title) {
      console.error('usage: tempad quest reword <id> "<title>" [--outcome]');
      return 2;
    }
    if (refuseRetractedQuest(context.database, id)) return 1;
    assertEditIntent(context.database, "quest", id, "reword");
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.reworded",
        subject: id,
        payload: { title, outcome: values.outcome },
      }),
    );
    return 0;
  }

  if (subcommand === "replace") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { outcome: { type: "string" }, reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const [id, title] = positionals;
    if (!id || !title || !values.reason) {
      console.error('usage: tempad quest replace <id> "<title>" [--outcome] --reason "..."');
      return 2;
    }
    const old = findQuest(context.database, id);
    if (!old) {
      console.error(`unknown quest: ${id}`);
      return 1;
    }
    if (refuseRetractedQuest(context.database, id)) return 1;
    assertEditIntent(context.database, "quest", id, "replace");
    const newId = newUlid();
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: newId,
        payload: {
          owner: { kind: old.owner_kind, id: old.owner_id },
          title,
          outcome: values.outcome,
          confirmed: true,
        },
      }),
    );
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.ended",
        subject: id,
        payload: { reason: "replaced", replaced_by: newId, note: values.reason },
      }),
    );
    return 0;
  }

  if (subcommand === "end") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.reason) {
      console.error("usage: tempad quest end <id> --reason ...");
      return 2;
    }
    if (refuseRetractedQuest(context.database, id)) return 1;
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.ended",
        subject: id,
        payload: { reason: values.reason },
      }),
    );
    return 0;
  }

  if (subcommand === "edit") {
    const [id, title] = rest;
    if (!id || !title) {
      console.error('usage: tempad quest edit <id> "<title>"');
      return 2;
    }
    if (refuseRetractedQuest(context.database, id)) return 1;
    assertEditIntent(context.database, "quest", id, undefined);
    applyIncremental(
      context.database,
      store.append({ actor: "hero", kind: "quest.reworded", subject: id, payload: { title } }),
    );
    return 0;
  }

  if (subcommand === "confirm") {
    const id = rest[0];
    if (!id) {
      console.error("usage: tempad quest confirm <id>");
      return 2;
    }
    const resolved = resolveExistingQuest(context.database, id);
    if (!resolved) {
      console.error(unavailableQuestMessage(context.database, id));
      return 1;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.confirmed",
        subject: resolved,
        payload: {},
      }),
    );
    return 0;
  }

  if (subcommand === "merge") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { into: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.into) {
      console.error("usage: tempad quest merge <id> --into <id>");
      return 2;
    }
    const source = resolveExistingQuest(context.database, id);
    if (!source) {
      console.error(unavailableQuestMessage(context.database, id));
      return 1;
    }
    const target = resolveExistingQuest(context.database, values.into);
    if (!target) {
      console.error(unavailableQuestMessage(context.database, values.into));
      return 1;
    }
    if (source === target) {
      console.error(`quest ${id} cannot be merged into itself`);
      return 1;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.merged",
        subject: source,
        payload: { into: target },
      }),
    );
    return 0;
  }

  if (["pause", "resume", "done", "abandon"].includes(subcommand ?? "")) {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { reason: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id) {
      console.error(`usage: tempad quest ${subcommand} <id> [--reason]`);
      return 2;
    }
    const resolved = resolveExistingQuest(context.database, id);
    if (!resolved) {
      console.error(unavailableQuestMessage(context.database, id));
      return 1;
    }
    const stateBySubcommand: Record<string, string> = {
      pause: "paused",
      resume: "resumed",
      done: "done",
      abandon: "abandoned",
    };
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.lifecycle",
        subject: resolved,
        payload: { state: stateBySubcommand[subcommand as string], reason: values.reason },
      }),
    );
    return 0;
  }

  if (subcommand === "branch") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        "deviates-from": { type: "string" },
        trigger: { type: "string" },
        kind: { type: "string", default: "unknown" },
      },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values["deviates-from"] || !values.trigger) {
      console.error(
        'usage: tempad quest branch <id> --deviates-from <stint-id> --trigger "..." [--kind ...]',
      );
      return 2;
    }
    const resolved = resolveExistingQuest(context.database, id);
    if (!resolved) {
      console.error(unavailableQuestMessage(context.database, id));
      return 1;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.branched",
        subject: resolved,
        payload: {
          deviates_from: values["deviates-from"],
          trigger: values.trigger,
          kind: values.kind,
        },
      }),
    );
    return 0;
  }

  if (subcommand === "return") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { to: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    if (!id || !values.to) {
      console.error("usage: tempad quest return <id> --to <quest-id>");
      return 2;
    }
    const resolved = resolveExistingQuest(context.database, id);
    if (!resolved) {
      console.error(unavailableQuestMessage(context.database, id));
      return 1;
    }
    const target = resolveExistingQuest(context.database, values.to);
    if (!target) {
      console.error(unavailableQuestMessage(context.database, values.to));
      return 1;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.returned",
        subject: resolved,
        payload: { to_quest: target },
      }),
    );
    return 0;
  }

  if (subcommand === "retract" || subcommand === "delete") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { reason: { type: "string" }, force: { type: "boolean", default: false } },
      strict: true,
      allowPositionals: true,
    });
    const id = positionals[0];
    const reason = values.reason?.trim();
    if (!id || !reason) {
      console.error(`usage: tempad quest ${subcommand} <id> --reason "..." [--force]`);
      return 2;
    }
    // The id is taken exactly as named, not followed through `merged_into`:
    // every other command resolves a merged-away id to its target, which here
    // would retract a different quest than the one the operator typed.
    const row = context.database
      .query("SELECT id, retracted_at, merged_into FROM quests WHERE id = ?")
      .get(id) as { id: string; retracted_at: string | null; merged_into: string | null } | null;
    if (!row) {
      console.error(`unknown quest ${id}`);
      return 1;
    }
    if (row.retracted_at !== null) {
      context.stdout(`quest ${id} is already retracted; nothing to do`);
      return 0;
    }
    const dependents = questDependents(context.database, id);
    // Traces only exist under stints, so a trace count adds nothing here.
    const blocked =
      dependents.stints.length > 0 ||
      dependents.childQuests.length > 0 ||
      dependents.mergedInto !== null;
    if (blocked && !values.force) {
      console.error(describeDependents(id, dependents));
      return 1;
    }

    const retracted = { traces: 0, stints: 0, quests: 0 };
    // One transaction: a push between two of these events would otherwise ship
    // a half-applied cascade. The store shares this handle, so its own
    // per-append transaction nests as a savepoint.
    context.database
      .transaction(() => {
        if (blocked) {
          // `--force` retracts dependents, it does not detach them: there is no
          // event that moves a stint or child quest off a quest, and a stint left
          // pointing at a retracted quest would report its time as unattributed
          // work on a quest nobody can see. Traces go first, then stints, then
          // child quests (each with its own dependents), then the quest itself.
          // Quests merged into this one go too: their work was folded into it.
          // The quest this one was merged into is untouched. A question still
          // waiting on a retracted trace is expired, or the hand-back would
          // later ask about work that no longer exists.
          const cascadeReason = `${reason} (with quest ${id})`;
          const closure = questClosure(context.database, id);
          for (const questId of closure) {
            const own = questDependents(context.database, questId);
            for (const trace of own.traces) {
              retractRow(store, context.database, trace, cascadeReason);
              retracted.traces += 1;
              expirePendingQuestions(store, context.database, trace);
            }
            for (const stint of own.stints) {
              retractRow(store, context.database, stint, cascadeReason);
              retracted.stints += 1;
            }
          }
          for (const questId of [...closure].reverse()) {
            if (questId === id) continue;
            retractRow(store, context.database, questId, cascadeReason);
            retracted.quests += 1;
          }
        }
        retractRow(store, context.database, id, reason);
      })
      .immediate();
    const cascade = blocked
      ? ` (also retracted: ${retracted.traces} traces, ${retracted.stints} stints, ${retracted.quests} child quests)`
      : "";
    context.stdout(`retracted quest ${id}${cascade}`);
    return 0;
  }

  if (subcommand === "list") {
    const { values } = parseArgs({
      args: rest,
      options: {
        all: { type: "boolean", default: false },
        unconfirmed: { type: "boolean", default: false },
        side: { type: "boolean", default: false },
        "as-of": { type: "string" },
      },
      strict: true,
    });
    const source = values["as-of"]
      ? stateAsOf(context.database, values["as-of"])
      : context.database;
    const clauses: string[] = [];
    if (!values.all) {
      clauses.push("ended_at IS NULL");
      clauses.push("merged_into IS NULL");
      clauses.push("retracted_at IS NULL");
    }
    if (values.unconfirmed) clauses.push("confirmed = 0");
    if (values.side) clauses.push("deviates_from_stint_id IS NOT NULL");
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = source
      .query(
        `SELECT id, title, state, confirmed, retracted_at FROM quests ${where} ORDER BY created_at`,
      )
      .all() as {
      id: string;
      title: string;
      state: string;
      confirmed: number;
      retracted_at: string | null;
    }[];
    for (const row of rows) {
      const unconfirmed = row.confirmed === 0 ? " [unconfirmed]" : "";
      const retracted = row.retracted_at !== null ? " (retracted)" : "";
      context.stdout(`${row.id}  ${row.title}  (${row.state})${unconfirmed}${retracted}`);
    }
    return 0;
  }

  if (subcommand === "declare") {
    const { values } = parseArgs({
      args: rest,
      options: QUEST_DECLARE_OPTIONS,
      strict: true,
    });

    const usage =
      'usage: tempad quest declare --session <id> [--parent <id>] (--quest <id> | --new "<title>" --outcome "<text>" [--commitment promised|personal|exploratory] [--project <slug>] [--serves <saga id>] [--advances <quest id> | --deviates-from <quest id> --trigger "<sentence>" --kind waiting|blocker|curiosity|unknown] [--origin <quest id> --trigger "<sentence>" --kind waiting|blocker|curiosity|unknown] | --done <quest>) [--plan "a; b; c"] [--by agent|hero] [--at <iso>]';

    if (!values.session) {
      console.error(usage);
      return 2;
    }
    // `--done` retires a declaration; it names an existing quest and nothing
    // else, so every flag that describes what is being declared is excluded.
    if (values.done) {
      if (
        values.quest ||
        values.new ||
        values.plan ||
        values.origin ||
        values.serves ||
        values.advances ||
        values["deviates-from"]
      ) {
        console.error(usage);
        return 2;
      }
      const resolved = resolveExistingQuest(context.database, values.done);
      if (!resolved) {
        console.error(unavailableQuestMessage(context.database, values.done));
        return 1;
      }
      const heroForDoneId = currentHeroId(context.database);
      const heroForDone = heroForDoneId ? { id: heroForDoneId } : null;
      if (!heroForDone) {
        console.error("run `tempad hero init` first");
        return 1;
      }
      // Ending a declaration the session never made (or already ended) writes an
      // event that changes nothing, so it is a mistake worth reporting rather
      // than a silent no-op -- most often a typo'd quest or the wrong session.
      // `--parent` declares subagent scope, so the guard has to look at the
      // same scope the ending event will be written in -- session-scope
      // declarations are a different set entirely.
      const activeNow = activeDeclaredQuests(context.database, {
        sessionId: values.session,
        at: values.at ?? new Date().toISOString(),
        scope: values.parent ? "subagent" : "session",
        parentSessionId: values.parent,
      });
      if (!activeNow.some((quest) => quest.questId === resolved)) {
        console.error(`quest ${resolved} is not active in session ${values.session}`);
        return 1;
      }
      const doneResult = declareQuest(store, context.database, {
        sessionId: values.session,
        parentSessionId: values.parent,
        questId: resolved,
        done: true,
        plan: [],
        scope: values.parent ? "subagent" : "session",
        declaredBy: values.by === "hero" ? "hero" : "agent",
        at: values.at ?? new Date().toISOString(),
        heroId: heroForDone.id,
      });
      context.stdout(`declared ${doneResult.questId} done`);
      return 0;
    }
    if ((values.quest && values.new) || (!values.quest && !values.new)) {
      console.error(usage);
      return 2;
    }
    if (values.new && !values.outcome) {
      console.error(usage);
      return 2;
    }
    if (values.origin && (!values.trigger || !values.kind)) {
      console.error(usage);
      return 2;
    }
    // `--serves`/`--advances`/`--deviates-from` only describe a quest being
    // created: naming them alongside `--quest` would attach a relation to a
    // quest that already has whatever relations it has.
    if ((values.serves || values.advances || values["deviates-from"]) && !values.new) {
      console.error(usage);
      return 2;
    }
    // A quest either contributes to another (`--advances`) or pivots away
    // from one (`--deviates-from`) -- never both, per the ubiquitous-language
    // spec's relation table ("Never both").
    if (values.advances && values["deviates-from"]) {
      console.error(usage);
      return 2;
    }
    if (values["deviates-from"] && (!values.trigger || !values.kind)) {
      console.error(usage);
      return 2;
    }
    // `--origin` and `--deviates-from` name the same relation under two
    // flags (the latter is the vocabulary-aligned spelling); naming both
    // would leave it ambiguous which one wins.
    if (values.origin && values["deviates-from"]) {
      console.error(usage);
      return 2;
    }
    const heroRowId = currentHeroId(context.database);
    const heroRow = heroRowId ? { id: heroRowId } : null;
    if (!heroRow) {
      console.error("run `tempad hero init` first");
      return 1;
    }

    let resolvedQuest: string | undefined;
    if (values.quest) {
      const resolved = resolveExistingQuest(context.database, values.quest);
      if (!resolved) {
        console.error(unavailableQuestMessage(context.database, values.quest));
        return 1;
      }
      resolvedQuest = resolved;
    }

    // The quests a new one advances or pivots away from must exist and be live;
    // a retracted one is gone, and a relation to it would dangle.
    const relations: Record<"advances" | "origin" | "deviates-from", string | undefined> = {
      advances: undefined,
      origin: undefined,
      "deviates-from": undefined,
    };
    for (const flag of ["advances", "origin", "deviates-from"] as const) {
      const named = values[flag];
      if (!named) continue;
      const resolved = resolveExistingQuest(context.database, named);
      if (!resolved) {
        console.error(unavailableQuestMessage(context.database, named));
        return 1;
      }
      relations[flag] = resolved;
    }

    const plan = values.plan
      ? values.plan
          .split(";")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [];

    const result = declareQuest(store, context.database, {
      sessionId: values.session,
      parentSessionId: values.parent,
      questId: resolvedQuest,
      newQuest: values.new
        ? {
            title: values.new,
            outcome: values.outcome as string,
            commitment: (values.commitment as Commitment) ?? "personal",
            project: values.project,
            origin: relations.origin ?? relations["deviates-from"],
            trigger: values.trigger,
            kind: values.kind as BranchKind | undefined,
            serves: values.serves,
            advances: relations.advances,
          }
        : undefined,
      plan,
      scope: values.parent ? "subagent" : "session",
      declaredBy: values.by === "hero" ? "hero" : "agent",
      at: values.at ?? new Date().toISOString(),
      heroId: heroRow.id,
    });
    context.stdout(`declared ${result.questId}${result.created ? " (new)" : ""}`);
    return 0;
  }

  console.error(
    "usage: tempad quest add|reword|replace|end|edit|confirm|merge|pause|resume|done|abandon|branch|return|retract|delete|list|declare ...",
  );
  return 2;
}

function runStintCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") {
    const { values } = parseArgs({
      args: rest,
      options: { open: { type: "boolean", default: false }, quest: { type: "string" } },
      strict: true,
    });
    const clauses: string[] = ["retracted_at IS NULL"];
    const parameters: string[] = [];
    if (values.open) clauses.push("closed_at IS NULL");
    if (values.quest) {
      clauses.push("quest_id = ?");
      parameters.push(values.quest);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = context.database
      .query(`SELECT id, outcome, quest_id, closed_at FROM stints ${where} ORDER BY opened_at`)
      .all(...parameters) as {
      id: string;
      outcome: string;
      quest_id: string | null;
      closed_at: string | null;
    }[];
    for (const row of rows) {
      const status = row.closed_at ? "closed" : "open";
      context.stdout(
        `${row.id}  ${row.outcome}  (${status})${row.quest_id ? ` quest=${row.quest_id}` : ""}`,
      );
    }
    return 0;
  }
  console.error("usage: tempad stint list [--open] [--quest <id>]");
  return 2;
}

function runTraceCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") {
    const { values } = parseArgs({
      args: rest,
      options: { since: { type: "string" }, stint: { type: "string" } },
      strict: true,
    });
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (values.since) {
      clauses.push("started_at >= ?");
      parameters.push(values.since);
    }
    if (values.stint) {
      clauses.push("stint_id = ?");
      parameters.push(values.stint);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = context.database
      .query(`SELECT id, stint_id, what, why, confidence FROM traces ${where} ORDER BY started_at`)
      .all(...parameters) as {
      id: string;
      stint_id: string;
      what: string;
      why: string;
      confidence: number;
    }[];
    for (const row of rows) {
      context.stdout(
        `${row.id}  ${row.what}  why=${row.why}  confidence=${row.confidence}  stint=${row.stint_id}`,
      );
    }
    return 0;
  }
  console.error("usage: tempad trace list [--since <iso>] [--stint <id>]");
  return 2;
}

interface ImpactMirrorRow {
  project: string | null;
  date: string | null;
  title: string | null;
}

function mirrorRowForImpact(database: Database, subject: string): ImpactMirrorRow | null {
  const ref = parseEvidenceRef(subject);
  if (ref.kind === "commit") {
    const row = database
      .query(
        `SELECT r.project as project, c.authored_at as date, c.subject as title
         FROM gh_commits c JOIN gh_repos r ON r.full_name = c.repo WHERE c.sha = ?`,
      )
      .get(ref.sha) as ImpactMirrorRow | null;
    return row;
  }
  if (ref.kind === "pr") {
    const row = database
      .query(
        `SELECT r.project as project, p.created_at as date, p.title as title
         FROM gh_pull_requests p JOIN gh_repos r ON r.full_name = p.repo
         WHERE p.repo = ? AND p.number = ?`,
      )
      .get(ref.repo, ref.number) as ImpactMirrorRow | null;
    return row;
  }
  if (ref.kind === "monday") {
    const row = database
      .query(
        `SELECT project as project, updated_at as date, name as title FROM monday_items WHERE id = ?`,
      )
      .get(Number(ref.itemId)) as ImpactMirrorRow | null;
    return row;
  }
  const row = database
    .query(
      `SELECT project as project, started_at as date, title as title FROM claude_sessions WHERE id = ?`,
    )
    .get(ref.sessionId) as ImpactMirrorRow | null;
  return row;
}

function runImpactCommand(args: string[], context: IntentContext): number {
  const [subcommand, ...rest] = args;
  const store = new EventStore(context.database);

  if (subcommand === "set") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { theme: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    const [ref, text] = positionals;
    if (!ref || !text) {
      console.error(`usage: tempad impact set <ref> "<text>" [--theme <t>]`);
      console.error(`accepted ref shapes: ${EVIDENCE_REF_SHAPES}`);
      return 2;
    }
    if (text.trim().length === 0) {
      console.error("text must not be empty");
      return 1;
    }
    const parsed = parseEvidenceRef(ref);
    const subject = formatEvidenceRef(parsed);
    stateImpact(store, context.database, {
      subject,
      text,
      theme: values.theme ?? null,
      hero: "hero",
    });
    return 0;
  }

  if (subcommand === "list") {
    const { values } = parseArgs({
      args: rest,
      options: {
        project: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
      strict: true,
    });
    const rows = context.database
      .query(
        "SELECT subject, text, theme FROM impacts WHERE retracted_at IS NULL ORDER BY stated_at",
      )
      .all() as { subject: string; text: string; theme: string | null }[];
    for (const row of rows) {
      const mirror = mirrorRowForImpact(context.database, row.subject);
      if (values.project && mirror?.project !== values.project) continue;
      if (values.from && (!mirror?.date || mirror.date < values.from)) continue;
      if (values.to && (!mirror?.date || mirror.date > values.to)) continue;
      const theme = row.theme ? `[${row.theme}] ` : "";
      const mirrorSuffix = mirror
        ? `  (${mirror.project ?? "?"}, ${mirror.date ?? "?"}, "${mirror.title ?? "?"}")`
        : "  (not mirrored)";
      context.stdout(`${row.subject}  ${theme}${row.text}${mirrorSuffix}`);
    }
    return 0;
  }

  if (subcommand === "import") {
    const file = rest[0];
    if (!file) {
      console.error("usage: tempad impact import <file.json>");
      return 2;
    }

    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`import file could not be read: ${message}`);
      return 1;
    }

    let entries: { ref: string; text: string; theme?: string | null }[];
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        console.error("import file must contain a JSON array");
        return 1;
      }
      entries = parsed as { ref: string; text: string; theme?: string | null }[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`import file is not valid JSON: ${message}`);
      return 1;
    }

    const errors: string[] = [];
    const validated: { subject: string; text: string; theme: string | null }[] = [];
    entries.forEach((entry, index) => {
      const position = index + 1;
      let subject: string;
      try {
        subject = formatEvidenceRef(parseEvidenceRef(entry.ref));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`entry ${position}: ${message}`);
        return;
      }
      if (!entry.text || entry.text.trim().length === 0) {
        errors.push(`entry ${position}: text must not be empty`);
        return;
      }
      const theme = entry.theme ?? null;
      if (theme !== null && !THEME_PATTERN.test(theme)) {
        errors.push(`entry ${position}: --theme must match ${THEME_PATTERN.source}: ${theme}`);
        return;
      }
      validated.push({ subject, text: entry.text, theme });
    });

    if (errors.length > 0) {
      for (const error of errors) console.error(error);
      return 1;
    }

    const applyAll = context.database.transaction(() => {
      for (const entry of validated) {
        stateImpact(store, context.database, {
          subject: entry.subject,
          text: entry.text,
          theme: entry.theme,
          hero: "hero",
        });
      }
    });
    applyAll();
    context.stdout(`imported=${validated.length}`);
    return 0;
  }

  console.error("usage: tempad impact set|list|import ...");
  return 2;
}

const BRANCH_KINDS = new Set<string>(["waiting", "blocker", "curiosity", "unknown"]);

/**
 * The stint a side quest branched *from*: the most recent stint of the same
 * session, on the quest the doubted stint currently sits under (its declared
 * quest), that opened before the doubted stint did.
 *
 * Deliberately not the doubted stint itself -- the caller reassigns that one to
 * the new quest, so using it would record the new quest as branching from its own
 * stint. Matches `apply.ts`'s convention of branching from the *previous*
 * segment's stint. Null when the doubted stint is the session's first on
 * that quest, which is a real outcome: there is nothing it branched away from.
 */
function originStintId(database: Database, doubtedStintId: string): string | null {
  const doubted = database
    .query(
      `SELECT stints.quest_id as questId, stints.opened_at as openedAt,
              (SELECT traces.session_id FROM traces
                WHERE traces.stint_id = stints.id AND traces.retracted_at IS NULL
                ORDER BY traces.started_at ASC LIMIT 1) as sessionId
         FROM stints WHERE stints.id = ?`,
    )
    .get(doubtedStintId) as {
    questId: string | null;
    openedAt: string;
    sessionId: string | null;
  } | null;
  if (!doubted || doubted.questId === null || doubted.sessionId === null) return null;

  const row = database
    .query(
      `SELECT stints.id as id FROM stints
        WHERE stints.quest_id = ?
          AND stints.id != ?
          AND stints.opened_at < ?
          AND stints.retracted_at IS NULL
          AND EXISTS (SELECT 1 FROM traces
                       WHERE traces.stint_id = stints.id
                         AND traces.session_id = ?
                         AND traces.retracted_at IS NULL)
        ORDER BY stints.opened_at DESC LIMIT 1`,
    )
    .get(doubted.questId, doubtedStintId, doubted.openedAt, doubted.sessionId) as {
    id: string;
  } | null;
  return row?.id ?? null;
}

function runAnswerCommand(args: string[], context: IntentContext): number {
  const { values, positionals } = parseArgs({
    args,
    options: {
      quest: { type: "string" },
      why: { type: "string" },
      belongs: { type: "boolean", default: false },
      origin: { type: "string" },
      trigger: { type: "string" },
      kind: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
  const questionId = positionals[0];
  const usage =
    'usage: tempad answer <question-id> --belongs | --quest <id|new:"title"> [--why "..."] [--origin current --trigger "..." --kind waiting|blocker|curiosity|unknown]';
  // Exactly one of the two: `--belongs` confirms the declared quest, `--quest`
  // moves the trace somewhere else. Both together says nothing coherent.
  if (!questionId || (values.belongs ? values.quest !== undefined : !values.quest)) {
    console.error(usage);
    return 2;
  }
  const question = context.database
    .query("SELECT trace_id, kind FROM questions WHERE id = ?")
    .get(questionId) as { trace_id: string; kind: string } | null;
  if (!question) {
    console.error(`unknown question: ${questionId}`);
    return 1;
  }
  const trace = context.database
    .query("SELECT stint_id FROM traces WHERE id = ?")
    .get(question.trace_id) as { stint_id: string } | null;
  if (!trace) {
    console.error(`unknown trace: ${question.trace_id}`);
    return 1;
  }

  if (values.belongs && question.kind !== "belongs") {
    console.error(`--belongs is only valid for a belongs-kind question, not "${question.kind}"`);
    return 1;
  }

  const store = new EventStore(context.database);

  if (values.belongs) {
    // "Yes it belongs" confirms the declared quest, so the trace and its
    // stint's quest are left exactly as they are.
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "question.answered",
        subject: questionId,
        payload: { answeredBy: "hero", belongs: true, why: values.why },
      }),
    );
    return 0;
  }

  const quest = values.quest as string;
  const isNewQuest = quest.startsWith("new:");
  let questId: string;
  if (isNewQuest) {
    const title = quest.slice("new:".length);
    const heroId = requireHero(context.database);
    questId = newUlid();
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.created",
        subject: questId,
        payload: { owner: { kind: "hero", id: heroId }, title, confirmed: false },
      }),
    );
  } else {
    questId = resolveQuest(context.database, quest);
    if (questRetracted(context.database, questId)) {
      console.error(`quest ${questId} is retracted`);
      return 1;
    }
  }

  // `--origin current` is the answer-time equivalent of a live declaration's
  // `--origin`: the answer itself is what reveals a side quest existed, branching
  // from the quest being *left*, never from the stint this command is about to
  // reassign to the new quest -- that would record a quest as branching from its
  // own stint.
  if (values.origin !== undefined) {
    if (values.origin !== "current") {
      console.error("--origin must be current");
      return 2;
    }
    if (!isNewQuest) {
      console.error('--origin is only meaningful with --quest new:"<title>"');
      return 2;
    }
    const kind = values.kind ?? "unknown";
    if (!BRANCH_KINDS.has(kind)) {
      console.error("--kind must be waiting|blocker|curiosity|unknown");
      return 2;
    }
    applyIncremental(
      context.database,
      store.append({
        actor: "hero",
        kind: "quest.branched",
        subject: questId,
        payload: {
          deviates_from: originStintId(context.database, trace.stint_id),
          trigger: values.trigger ?? "unknown",
          kind,
        },
      }),
    );
  }

  answerQuestion(store, context.database, questionId, questId, values.why, "hero");
  assignStint(store, context.database, trace.stint_id, questId, "hero");
  return 0;
}

function runRebuildCommand(args: string[], context: IntentContext): number {
  const { values } = parseArgs({ args, options: { until: { type: "string" } }, strict: true });
  rebuildAll(context.database, { until: values.until });
  if (values.until) {
    context.stdout(
      `projections now reflect state as of ${values.until}; run tempad rebuild to restore`,
    );
  }
  return 0;
}

export async function runIntentCommand(args: string[], context: IntentContext): Promise<number> {
  const [command, ...rest] = args;
  try {
    ensureTables(context.database);
    switch (command) {
      case "hero":
        return runHeroCommand(rest, context);
      case "party":
        return runPartyCommand(rest, context);
      case "client":
        return runClientCommand(rest, context);
      case "saga":
        return runSagaCommand(rest, context);
      case "quest":
        return runQuestCommand(rest, context);
      case "stint":
        return runStintCommand(rest, context);
      case "trace":
        return runTraceCommand(rest, context);
      case "impact":
        return runImpactCommand(rest, context);
      case "answer":
        return runAnswerCommand(rest, context);
      case "rebuild":
        return runRebuildCommand(rest, context);
      default:
        console.error("unknown command");
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export { resolveOwner };
