import type { Actor } from "@sentry/junior-plugin-api";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { listWatches } from "@/chat/events/store";
import { readChildConversationSender } from "./child-input";
import { hasWaitingParentWork } from "./list";
import { childAgentStillWorks } from "./store";

/**
 * Return the Actor that a child Turn's update carries to its parent, whose
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
 * Return whether the work of a child agent goes on after a Turn ends: one
 * of its own child agents still works, it has an active Watch or Timer, or
 * input waits to run a later Turn. A `done` update from it is then not its
 * last word. A root has no starter, so its work never goes on here.
 */
export async function childWorkGoesOn(
  conversationId: string,
): Promise<boolean> {
  if (!(await readChildConversationSender(conversationId))) return false;
  const [stillWorks, watches, waiting] = await Promise.all([
    childAgentStillWorks(conversationId),
    listWatches({ conversationId }),
    hasWaitingParentWork(conversationId),
  ]);
  return stillWorks || watches.length > 0 || waiting;
}
