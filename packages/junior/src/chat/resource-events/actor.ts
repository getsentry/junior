/**
 * System Actor for resource-event Turns.
 *
 * Resource-event mailbox Messages are not from a person. They use this Actor
 * for credentials and attribution. Mailbox input stores the author ID. Resume
 * rebuilds the same Actor from the saved Turn input.
 */
import type { Actor } from "@/chat/actor";

/**
 * System author ID stamped on resource-event mailbox messages.
 *
 * Keep this stable so conversation history can recognize the same system input
 * for resource-event Turns.
 *
 * TODO(dcramer): Delete this ID after resumes read resource-event Source.kind
 * from the Turn checkpoint instead of Message author data.
 */
export const RESOURCE_EVENT_AUTHOR_ID = "UJRNEVENT";

/** System Message author for resource-event input. */
export const RESOURCE_EVENT_MESSAGE_AUTHOR = {
  fullName: "Junior event",
  isBot: true,
  userId: RESOURCE_EVENT_AUTHOR_ID,
  userName: "junior-event",
} as const;

/** System execution actor for every resource-event turn. */
export const RESOURCE_EVENT_SYSTEM_ACTOR = {
  platform: "system",
  name: "resource-event",
} as const satisfies Actor;

/**
 * Whether a saved Message started a resource-event Turn.
 *
 * TODO(dcramer): Delete this marker check after resumes read Source.kind from
 * the Turn checkpoint. `eventType` only supports saved synthetic Slack input.
 */
export function isResourceEventConversationMessage(message: {
  author?: { userId?: string };
  meta?: { eventType?: string };
}): boolean {
  return (
    Boolean(message.meta?.eventType) ||
    message.author?.userId === RESOURCE_EVENT_AUTHOR_ID
  );
}
