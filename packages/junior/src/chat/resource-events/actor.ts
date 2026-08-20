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

interface ResourceEventSlackMessage {
  id?: string;
  raw?: unknown;
}

function resourceEventRaw(
  message: ResourceEventSlackMessage,
): Record<string, unknown> | undefined {
  return message.raw && typeof message.raw === "object"
    ? (message.raw as Record<string, unknown>)
    : undefined;
}

function resourceEventSummary(message: ResourceEventSlackMessage): string {
  const raw = resourceEventRaw(message);
  const summary =
    typeof raw?.resource_event_summary === "string"
      ? oneLine(raw.resource_event_summary, 128)
      : "";
  if (summary) {
    return summary;
  }
  return typeof raw?.resource_event_label === "string"
    ? oneLine(raw.resource_event_label, 128)
    : "";
}

/** Build plain Slack context for every resource event that contributed to a turn. */
export function replyAttributionForResourceEventMessages(
  messages: readonly ResourceEventSlackMessage[],
): ReplyAttribution | undefined {
  const events = messages.filter(isResourceEventSlackMessage);
  if (events.length === 0) {
    return undefined;
  }
  const latestSummary = resourceEventSummary(events.at(-1) ?? {});
  if (events.length === 1) {
    return latestSummary
      ? { label: "Update", detail: latestSummary }
      : { label: "Update" };
  }
  const detail = latestSummary
    ? oneLine(`${latestSummary} (+${events.length - 1} more)`, 128)
    : undefined;
  return {
    label: `${events.length} updates`,
    ...(detail ? { detail } : {}),
  };
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
