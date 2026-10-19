/**
 * Who authored a window message. The transcript's `role` is not enough: Claude
 * Code writes machine-generated text into `user`-role messages (system
 * reminders, task notifications, tool-result wrappers, the synthetic first turn
 * that opens a subagent), and those are never the human's words. The verifier's
 * deviation rule keys on a *human-authored* trigger, so every message the prompt
 * lists carries the label this module computes from what `claude_messages`
 * already stores (`role`, `origin_kind`, `text_preview`).
 *
 * The label is inference over stored facts only -- no transcript re-read, no
 * model call.
 */

/** Who wrote a message: the operator, an agent, or a machine/system wrapper. */
export type MessageAuthorship = "human" | "agent" | "tool";

/**
 * `text_preview` prefixes of user-role messages Claude Code itself generated.
 * A tool result usually carries no text block at all (so `text_preview` is null
 * and the row never reaches a window), and the ones that do carry text start
 * with one of these wrappers.
 */
const MACHINE_TEXT_MARKERS = [
  "<system-reminder>",
  "[SYSTEM NOTIFICATION",
  "<task-notification>",
  "<command-name>",
  "<local-command",
  "<bash-input",
] as const;

export interface MessageAuthorshipInput {
  role: string;
  /** `claude_messages.origin_kind`: `"human"` for the operator's own turns. */
  originKind?: string | null;
  text?: string | null;
}

/**
 * Pure classification, cheapest signal first:
 *
 * - `assistant` messages are the agent's; `system` messages are machine wrappers.
 * - a `user` message with `origin_kind = "human"` is the operator's own words;
 *   any other non-null origin (`peer`, harness-injected) is another machine's.
 * - an origin-less `user` message whose text starts with a machine marker is a
 *   wrapper (tool), and the synthetic subagent opener ("You are ...", the same
 *   case-sensitive prefix `ruleKind` keys on) is an agent's.
 * - anything else in the `user` role is the human: Claude Code only omits
 *   `origin` on genuinely human turns.
 */
export function messageAuthorship(input: MessageAuthorshipInput): MessageAuthorship {
  const { role, originKind } = input;
  if (role === "assistant") return "agent";
  if (role === "system") return "tool";

  if (role === "user") {
    if (originKind === "human") return "human";
    if (originKind != null) return "agent";

    const text = input.text ?? "";
    if (MACHINE_TEXT_MARKERS.some((marker) => text.startsWith(marker))) return "tool";
    if (text.startsWith("You are")) return "agent";
    return "human";
  }

  // Unknown roles (future harnesses): assume the machine, never the human --
  // a false "human" would legitimize a deviation trigger that no person wrote.
  return "agent";
}
