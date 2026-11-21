import type { WaitingConversation } from "../inbox/queries";
import type { Conversation } from "../types";

/** How the Lead shows one Conversation of the viewer. */
export type LeadWorkState = "needs_you" | "working" | "failed" | "done";

/**
 * Pick the Lead state of one Conversation. Needs you comes only from open
 * action Review items assigned to the viewer (`design/attention.md`).
 *
 * The feed has no failed status. `needs_input` without a Review item, a
 * sign-in, or a finished Brief is a failed latest Turn or a `blocked` or
 * `partial` Brief, so it reads as Failed.
 */
export function leadWorkState(
  conversation: Conversation,
  waiting: WaitingConversation | undefined,
): LeadWorkState {
  if (waiting) return "needs_you";
  if (conversation.turnActive || conversation.status === "working") {
    return "working";
  }
  if (
    conversation.status === "needs_input" &&
    !conversation.awaitingAuthorization &&
    conversation.brief?.status !== "answered" &&
    conversation.brief?.status !== "done"
  ) {
    return "failed";
  }
  return "done";
}
