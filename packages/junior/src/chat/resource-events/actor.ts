/**
 * Execution identity for resource-event turns.
 *
 * Resource-event mailbox messages are synthetic (not human-authored). They
 * always run as this system principal for credentials and attribution.
 * Live dispatch stamps the author id / raw marker; resume rebuilds the same
 * system actor from those durable markers.
 */
import type { ReplyAttribution } from "@sentry/junior-plugin-api";
import type { Actor } from "@/chat/actor";

/** Synthetic Slack author id stamped on resource-event mailbox messages. */
export const RESOURCE_EVENT_SLACK_AUTHOR_ID = "UJRNEVENT";

/** System execution actor for every resource-event turn. */
export const RESOURCE_EVENT_SYSTEM_ACTOR = {
  platform: "system",
  name: "resource-event",
} as const satisfies Actor;

function oneLine(value: string, maxLength: number): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function resourceEventRaw(message: {
  raw?: unknown;
}): Record<string, unknown> | undefined {
  return message.raw && typeof message.raw === "object"
    ? (message.raw as Record<string, unknown>)
    : undefined;
}

/** Compact destination-visible context for resource-event subscription replies. */
export function resourceEventReplyAttribution(args: {
  eventType: string;
  label: string;
}): ReplyAttribution {
  const label = oneLine(args.label, 128);
  const eventType = oneLine(args.eventType, 128);
  const detail = oneLine(
    label && eventType ? `${label} · ${eventType}` : label || eventType,
    128,
  );
  return detail ? { label: "Event", detail } : { label: "Event" };
}

/** Whether a durable conversation message is a resource-event turn input. */
export function isResourceEventConversationMessage(message: {
  author?: { userId?: string };
  meta?: { eventType?: string };
}): boolean {
  return (
    Boolean(message.meta?.eventType) ||
    message.author?.userId === RESOURCE_EVENT_SLACK_AUTHOR_ID
  );
}

/**
 * Whether a Slack Message payload is a synthetic resource-event notification.
 * Checks the raw `event_type` marker stamped at mailbox serialization.
 */
export function isResourceEventSlackMessage(message: {
  raw?: unknown;
}): boolean {
  return resourceEventRaw(message)?.event_type === "resource_event";
}

/**
 * Destination-visible footer attribution for a resource-event Slack message.
 * Uses the label and event type stamped on the synthetic mailbox payload.
 */
export function replyAttributionForResourceEventMessage(message: {
  raw?: unknown;
}): ReplyAttribution | undefined {
  const raw = resourceEventRaw(message);
  if (raw?.event_type !== "resource_event") {
    return undefined;
  }
  const eventType =
    typeof raw.resource_event_type === "string" ? raw.resource_event_type : "";
  const label =
    typeof raw.resource_event_label === "string"
      ? raw.resource_event_label
      : "";
  if (!eventType && !label) {
    return { label: "Event" };
  }
  return resourceEventReplyAttribution({ eventType, label });
}
