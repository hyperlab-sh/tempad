/**
 * Who started a Claude session: the operator (`human`), the operator to
 * coordinate agents (`lead`), another agent (`subagent`), or nobody (`automated`).
 */
export const SESSION_KINDS = ["human", "lead", "subagent", "automated"] as const;

export type SessionKind = (typeof SESSION_KINDS)[number];

export function isSessionKind(value: unknown): value is SessionKind {
  return typeof value === "string" && (SESSION_KINDS as readonly string[]).includes(value);
}
