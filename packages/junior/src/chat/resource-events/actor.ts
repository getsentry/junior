/**
 * Execution identity for resource-event turns.
 *
 * Resource-event mailbox messages are synthetic (not human-authored). They
 * always run as this system principal for credentials and attribution.
 * Live dispatch stamps the author id / raw marker; resume rebuilds the same
 * system actor from those durable markers.
 */
import type { Actor } from "@/chat/actor";

/**
 * Synthetic author id stamped on resource-event mailbox messages.
 *
 * Kept stable so provider adapters and conversation history can recognize the
 * same system input for resource-event turns.
 */
export const RESOURCE_EVENT_AUTHOR_ID = "UJRNEVENT";

/** System execution actor for every resource-event turn. */
export const RESOURCE_EVENT_SYSTEM_ACTOR = {
  platform: "system",
  name: "resource-event",
} as const satisfies Actor;

/** Whether a durable conversation message is a resource-event turn input. */
export function isResourceEventConversationMessage(message: {
  author?: { userId?: string };
  meta?: { eventType?: string };
}): boolean {
  return (
    Boolean(message.meta?.eventType) ||
    message.author?.userId === RESOURCE_EVENT_AUTHOR_ID
  );
}

/**
 * Whether a Slack Message payload is a synthetic resource-event notification.
 * Checks the raw `event_type` marker stamped at mailbox serialization.
 */
export function isResourceEventSlackMessage(message: {
  raw?: unknown;
}): boolean {
  const raw =
    message.raw && typeof message.raw === "object"
      ? (message.raw as Record<string, unknown>)
      : undefined;
  return raw?.event_type === "resource_event";
}
