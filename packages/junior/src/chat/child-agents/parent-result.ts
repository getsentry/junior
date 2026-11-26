import type { Actor } from "@sentry/junior-plugin-api";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";

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
