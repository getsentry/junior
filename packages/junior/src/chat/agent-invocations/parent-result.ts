import type { Actor } from "@sentry/junior-plugin-api";
import { listWatches } from "@/chat/events/store";
import { getConversationWorkState } from "@/chat/task-execution/store";
import type { Reply } from "@/chat/turn-answer";
import { readChildConversationSender } from "./child-input";
import { listChildMessages } from "./child-message";
import { childAgentStillWorks } from "./store";

/**
 * What one child agent Turn sends its parent agent: its `reply`, a result
 * with no `reply` when its work ended quietly, or a blocked, failed, or
 * stopped result.
 */
export type ParentResult =
  | { kind: "reply"; reply: Reply }
  | { kind: "blocked" | "completed" | "failed" | "stopped"; text: string };

/**
 * Send one child agent Turn's result to the parent agent. `actor` is the
 * Actor of the Turn. Repeat calls for one result are safe.
 */
export type DeliverToParent = (args: {
  actor: Actor;
  result: ParentResult;
  conversationId: string;
  turnId: string;
}) => Promise<void>;

/**
 * Return whether a child's work ended with its Turn `turnId`, which ended
 * with no answer: none of its own child agents still works, it has no active
 * Watch or Timer, and the Turn sent its parent nothing. A Turn can send its
 * `reply` and then lose its worker, so its retry already reported.
 */
export async function childWorkEnded(
  conversationId: string,
  turnId: string,
): Promise<boolean> {
  const [stillWorks, watches, sender] = await Promise.all([
    childAgentStillWorks(conversationId),
    listWatches({ conversationId }),
    readChildConversationSender(conversationId),
  ]);
  if (stillWorks || watches.length > 0 || !sender) {
    return false;
  }
  const parent = await getConversationWorkState({
    conversationId: sender.parentConversationId,
  });
  return !listChildMessages(
    parent?.execution.inboundMessageIds ?? [],
    parent?.execution.messageSenders ?? {},
  ).some(
    (message) =>
      message.sender.conversationId === conversationId &&
      message.sender.turnId === turnId,
  );
}
