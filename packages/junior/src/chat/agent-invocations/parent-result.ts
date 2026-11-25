import type { Actor } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import {
  findActorIdentityId,
  SYSTEM_IDENTITY_ID,
} from "@/chat/identities/actor";
import { listWatches } from "@/chat/events/store";
import { readChildConversationSender } from "./child-input";
import { hasWaitingParentWork } from "./list";
import { readParentMessageAuthorIdentityIds } from "./parent-message-authors";
import { childAgentStillWorks } from "./store";

/**
 * Return the Actor that a child Turn's update carries to its parent, whose
 * Turn for it runs as that Actor. A Turn that a parent message started keeps
 * the Actor of the parent's Turn. A Turn that an Event started, such as a
 * child result, keeps its Actor only when it is the system or the author of
 * a parent message to this child, since that Actor came from the parent. Any
 * other Turn, such as a person's Turn in a Thread, the work of a child agent
 * that such a Turn started, or a saved Turn with no Source, reports as the
 * Event system Actor, so the parent never gets the access of a person who
 * did not give it work.
 */
export async function parentResultActor(args: {
  actor: Actor;
  conversationId: string;
  source: string | undefined;
}): Promise<Actor> {
  if (args.source === "parent_message") return args.actor;
  if (args.source !== "event") return EVENT_SYSTEM_ACTOR;
  const identityId = await findActorIdentityId(getDb(), args.actor);
  if (identityId === SYSTEM_IDENTITY_ID) return args.actor;
  const authors = await readParentMessageAuthorIdentityIds(args.conversationId);
  return identityId !== undefined && authors.includes(identityId)
    ? args.actor
    : EVENT_SYSTEM_ACTOR;
}

/**
 * Return whether the work of a child agent goes on after a Turn ends: one
 * of its own child agents still works, it has an active Watch or Timer, or
 * input waits to run a later Turn. A `noReply` end then has nothing new for
 * the agent that started it, which waits for the child's last word. A root
 * has no starter, so its work never goes on here.
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
