import { newUlid } from "../../src/intent/ids.ts";
import type { EventStore } from "../../src/intent/store.ts";

/**
 * Appends a side-quest declaration exactly as `declareQuest` wrote it before
 * `deviates_from_quest` existed: `quest.created` for the new quest, then a
 * `quest.branched` whose subject is the quest being left and whose
 * `deviates_from` is the new quest's id (the pair inverted), then the
 * `quest.declared`, all at the same `at`. Callers rebuild afterwards, the way
 * an existing database is re-projected after upgrading.
 */
export function appendLegacyDeclaredSideQuest(
  store: EventStore,
  input: {
    heroId: string;
    parentQuestId: string;
    title: string;
    at: string;
    sessionId?: string;
    trigger?: string;
    kind?: string;
  },
): string {
  const sideQuestId = newUlid();
  const sessionId = input.sessionId ?? "s1";
  store.append({
    actor: "hook",
    kind: "quest.created",
    subject: sideQuestId,
    at: input.at,
    payload: {
      owner: { kind: "hero", id: input.heroId },
      title: input.title,
      outcome: "o",
      commitment: "personal",
      confirmed: true,
      origin_kind: "declared",
    },
  });
  store.append({
    actor: "hook",
    kind: "quest.branched",
    subject: input.parentQuestId,
    at: input.at,
    payload: {
      deviates_from: sideQuestId,
      trigger: input.trigger ?? "noticed",
      kind: input.kind ?? "curiosity",
    },
  });
  store.append({
    actor: "hook",
    kind: "quest.declared",
    subject: sideQuestId,
    at: input.at,
    sessionId,
    payload: {
      session_id: sessionId,
      quest_id: sideQuestId,
      new: {
        title: input.title,
        outcome: "o",
        commitment: "personal",
        origin: input.parentQuestId,
        trigger: input.trigger ?? "noticed",
        kind: input.kind ?? "curiosity",
      },
      plan: [],
      scope: "session",
      declared_by: "agent",
      at: input.at,
    },
  });
  return sideQuestId;
}
