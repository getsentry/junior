import type { Actor } from "@sentry/junior-plugin-api";
import { isPersonInput } from "@/chat/conversations/kind-behavior";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { listWatches } from "@/chat/events/store";
import { getConversationWorkState } from "@/chat/task-execution/store";
import type { Reply } from "@/chat/turn-answer";
import { readChildConversationSender } from "./child-input";
import { listChildMessages } from "./child-message";
import { hasWaitingParentWork } from "./list";
import { childAgentStillWorks } from "./store";

/**
 * What one child agent Turn sends its parent agent: its `reply`, a completed
 * result when its work ended with final text or `noReply`, or a blocked,
 * failed, or stopped result.
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
 * Return the Actor that a child Turn's result carries to its parent, whose
 * Turn for it runs as that Actor. A person's Turn in a Thread reports as the
 * Event system Actor, so the parent never gets that person's access.
 */
export function parentResultActor(
  actor: Actor,
  source: string | undefined,
): Actor {
  return isPersonInput(source) ? EVENT_SYSTEM_ACTOR : actor;
}

/**
 * Return whether a child's work ended with its Turn `turnId`, which ended
 * with no answer: none of its own child agents still works, it has no active
 * Watch or Timer, no input waits to run a later Turn that answers, and the
 * Turn sent its parent nothing. A Turn can send its `reply` and then lose
 * its worker, so its retry already reported.
 */
export async function childWorkEnded(
  conversationId: string,
  turnId: string,
): Promise<boolean> {
  const [stillWorks, watches, waiting, sender] = await Promise.all([
    childAgentStillWorks(conversationId),
    listWatches({ conversationId }),
    hasWaitingParentWork(conversationId),
    readChildConversationSender(conversationId),
  ]);
  if (stillWorks || watches.length > 0 || waiting || !sender) {
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
