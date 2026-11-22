import type { WaitingConversation } from "../inbox/queries";
import type { Conversation } from "../types";

/** How the Lead shows one Conversation of the viewer. */
export type LeadWorkState = "needs_you" | "working" | "failed" | "done";

/**
 * Pick the Lead state of one Conversation. Needs you comes from open action
 * Inbox items assigned to the viewer (`design/attention.md`) and from a
 * sign-in that the Conversation waits on, as in the sidebar.
 *
 * The feed has no failed status. Turns no longer store Briefs, so
 * `needs_input` with neither of those is a failed latest Turn or an answer
 * the viewer has not read, and the feed cannot tell them apart. It reads as
 * Done. A watched Conversation's failure still shows as a Watch report.
 */
export function leadWorkState(
  conversation: Conversation,
  waiting: WaitingConversation | undefined,
): LeadWorkState {
  if (waiting || conversation.awaitingAuthorization) return "needs_you";
  if (conversation.turnActive || conversation.status === "working") {
    return "working";
  }
  return "done";
}
