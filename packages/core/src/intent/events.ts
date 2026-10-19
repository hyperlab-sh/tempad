export type Actor = "hero" | "assistant" | "hook" | "backfill" | "system";

export const EVENT_KINDS = [
  "hero.created",
  "party.created",
  "party.reworded",
  "membership.joined",
  "membership.left",
  "client.created",
  "project.created",
  "project.updated",
  "place.opened",
  "place.closed",
  "saga.created",
  "saga.reworded",
  "saga.ended",
  "quest.created",
  "quest.reworded",
  "quest.ended",
  "quest.confirmed",
  "quest.merged",
  "quest.lifecycle",
  "quest.branched",
  "quest.returned",
  "quest.declared",
  "agent.spawned",
  "stint.opened",
  "stint.reworded",
  "stint.closed",
  "stint.dismissed",
  "stint.assigned",
  "stint.continuation_cleared",
  "trace.recorded",
  "trace.relinked",
  "question.asked",
  "question.watched",
  "question.promoted",
  "question.answered",
  "question.expired",
  "retracted",
  "window.classified",
  "impact.stated",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventInput {
  at?: string;
  actor: Actor;
  sessionId?: string;
  kind: EventKind;
  subject: string;
  payload: Record<string, unknown>;
}

export interface EventRecord {
  /** Local row id. Differs between hosts; never an ordering or identity key. */
  id: number;
  /**
   * Global id (ULID) and replay order key. Null only for a row inserted by
   * hand, outside `EventStore`, since the database was opened; `openDatabase`
   * backfills those on the next open.
   */
  uid: string | null;
  at: string;
  recordedAt: string;
  actor: Actor;
  sessionId: string | null;
  kind: EventKind;
  subject: string;
  payload: Record<string, unknown>;
  /** Origin host's `HOST_SLUG`; null when appended with no `sync_local` row. */
  syncHost: string | null;
  /** True until push has sent the event; false once pushed, or when pulled. */
  syncDirty: boolean;
}
