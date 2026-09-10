/**
 * System Actor for event Turns.
 *
 * Resource-event mailbox Messages are not from a person. They use this Actor
 * for credentials and attribution. The Turn saves this Actor for resume.
 * Mailbox input keeps the author ID for deployed cursors without Actor.
 */
import type { Actor } from "@/chat/actor";

/**
 * System author ID stamped on event mailbox messages.
 *
 * Keep this stable so conversation history can recognize the same system input
 * for event Turns.
 *
 * TODO(dcramer): Delete this ID after resumes read event Source.kind
 * from the Turn checkpoint instead of Message author data.
 */
export const EVENT_AUTHOR_ID = "UJRNEVENT";

/** System Message author for event input. */
export const EVENT_MESSAGE_AUTHOR = {
  fullName: "Junior event",
  isBot: true,
  userId: EVENT_AUTHOR_ID,
  userName: "junior-event",
} as const;

/** System execution actor for every event turn. */
export const EVENT_SYSTEM_ACTOR = {
  platform: "system",
  name: "event",
} as const satisfies Actor;

/**
 * Whether a saved Message started a event Turn.
 *
 * TODO(dcramer): Delete this marker check after deployed Turn cursors all store
 * Source and Actor. `eventType` only supports saved synthetic Slack input.
 */
export function isEventConversationMessage(message: {
  author?: { userId?: string };
  meta?: { eventType?: string };
}): boolean {
  return (
    Boolean(message.meta?.eventType) ||
    message.author?.userId === EVENT_AUTHOR_ID
  );
}
