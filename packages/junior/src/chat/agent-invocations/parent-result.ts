import type { Actor } from "@sentry/junior-plugin-api";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { listWatches } from "@/chat/events/store";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { readChildConversationSender } from "./child-input";
import { listChildMessages } from "./child-message";
import { hasWaitingParentWork } from "./list";
import { childAgentStillWorks } from "./store";

/**
 * What one child agent Turn sends its parent agent: a completed result with
 * its final text or `noReply` note, or a blocked, failed, or stopped result.
 */
export type ParentResult = {
  kind: "blocked" | "completed" | "failed" | "stopped";
  text: string;
};

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
 * Turn for it runs as that Actor. Only a Turn that agent work started, a
 * parent message or an Event such as a child result, keeps its Actor. Any
 * other Turn, such as a person's Turn in a Thread or a saved Turn with no
 * Source, reports as the Event system Actor, so the parent never gets a
 * person's access.
 */
export function parentResultActor(
  actor: Actor,
  source: string | undefined,
): Actor {
  return source === "parent_message" || source === "event"
    ? actor
    : EVENT_SYSTEM_ACTOR;
}

/**
 * Return whether a child's work ended with its Turn `turnId`, which ended
 * with no answer: none of its own child agents still works, it has no active
 * Watch or Timer, no input waits to run a later Turn that answers, and the
 * Turn sent its parent nothing. A Turn can send its result and then lose
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
