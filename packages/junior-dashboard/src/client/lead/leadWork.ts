import type { WaitingConversation } from "../inbox/queries";
import type { Conversation } from "../types";

/** How the Lead shows one Conversation of the viewer. */
export type LeadWorkState = "needs_you" | "working" | "failed" | "done";

/**
 * Pick the Lead state of one Conversation. Needs you comes from open action
 * Inbox items assigned to the viewer (`design/attention.md`) and from a
 * sign-in that the Conversation waits on, as in the sidebar.
 */
export function leadWorkState(
  conversation: Conversation,
  waiting: WaitingConversation | undefined,
): LeadWorkState {
  if (waiting || conversation.awaitingAuthorization) return "needs_you";
  if (conversation.turnActive || conversation.status === "working") {
    return "working";
  }
  if (conversation.latestTurnFailed) return "failed";
  return "done";
}
