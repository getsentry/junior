/**
 * Slack adapter glue for resource-event mailbox wakes.
 *
 * Resource-event ingest stores plain conversation mailbox input. When the
 * conversation binding is Slack, this module fills Slack thread metadata so the
 * existing Slack worker can run the same agent surface.
 */
import type { SerializedMessage, SerializedThread } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import type { ConversationStore } from "@/chat/conversations/store";
import { requireSlackDestination } from "@/chat/destination";
import { RESOURCE_EVENT_AUTHOR_ID } from "@/chat/resource-events/actor";
import { isResourceEventMailboxMetadata } from "@/chat/resource-events/notification";
import { resolveConversationRouting } from "@/chat/services/turn-session-routing";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { InboundMessage } from "@/chat/task-execution/store";

interface SlackResourceEventInboundInput {
  conversationId: string;
  destination: {
    channelId: string;
    platform: "slack";
    teamId: string;
  };
  event: {
    eventKey: string;
    eventType: string;
    namespace: string;
    identifier: string;
    subscriptionId: string;
  };
  occurredAtMs: number;
  receivedAtMs?: number;
  text: string;
  threadTs: string;
}

function slackSerializedThread(input: {
  channelId: string;
  message: SerializedMessage;
  threadTs: string;
}): SerializedThread {
  return {
    _type: "chat:Thread",
    adapterName: "slack",
    channelId: input.channelId,
    currentMessage: input.message,
    id: `slack:${input.channelId}:${input.threadTs}`,
    isDM: input.channelId.startsWith("D"),
  };
}

/**
 * Serialize a synthetic resource-event mailbox message without a native Slack
 * message timestamp so Slack Web API calls cannot target the internal id.
 */
function slackSerializedResourceEventMessage(input: {
  channelId: string;
  eventType: string;
  id: string;
  text: string;
  threadTs: string;
  timestampIso: string;
}): SerializedMessage {
  return {
    _type: "chat:Message",
    attachments: [],
    author: {
      userId: RESOURCE_EVENT_AUTHOR_ID,
      userName: "junior-event",
      fullName: "Junior event",
      isBot: true,
      isMe: false,
    },
    formatted: { type: "root", children: [] },
    id: input.id,
    metadata: {
      dateSent: input.timestampIso,
      edited: false,
    },
    raw: {
      channel: input.channelId,
      event_type: "resource_event",
      resource_event_type: input.eventType,
      thread_ts: input.threadTs,
      type: "message",
      user: RESOURCE_EVENT_AUTHOR_ID,
    },
    text: input.text,
    threadId: `slack:${input.channelId}:${input.threadTs}`,
  };
}

function hasSlackConversationMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.platform === "slack" &&
    typeof record.thread === "object" &&
    record.thread !== null &&
    typeof record.message === "object" &&
    record.message !== null
  );
}

/**
 * Build a Slack-shaped mailbox record for a resource-event wake.
 *
 * Resource-event ingest stores plain mailbox input. The Slack worker uses this
 * only when the conversation binding is Slack and the turn needs Slack metadata.
 */
export function createSlackResourceEventInboundMessage(
  input: SlackResourceEventInboundInput,
): InboundMessage {
  const destination = input.destination;
  const threadTs = input.threadTs.trim();
  if (!threadTs) {
    throw new Error("Slack resource-event hydration requires a thread timestamp");
  }
  const messageId = `resource-event-${input.event.subscriptionId}-${input.event.eventKey}`;
  const timestampIso = new Date(input.occurredAtMs).toISOString();
  const message = slackSerializedResourceEventMessage({
    channelId: destination.channelId,
    eventType: input.event.eventType,
    id: messageId,
    text: input.text,
    threadTs,
    timestampIso,
  });
  const thread = slackSerializedThread({
    channelId: destination.channelId,
    message,
    threadTs,
  });
  return {
    conversationId: input.conversationId,
    createdAtMs: input.occurredAtMs,
    destination,
    inboundMessageId: `resource-event:${input.event.subscriptionId}:${input.event.eventKey}`,
    delivery: "defer",
    source: "resource_event",
    receivedAtMs: input.receivedAtMs ?? Date.now(),
    publishExternally: true,
    input: {
      text: input.text,
      authorId: RESOURCE_EVENT_AUTHOR_ID,
      metadata: {
        kind: "resource_event",
        installation: {
          teamId: destination.teamId,
        },
        platform: "slack",
        route: "subscribed",
        thread,
        message,
        resourceEvent: {
          eventKey: input.event.eventKey,
          eventType: input.event.eventType,
          namespace: input.event.namespace,
          identifier: input.event.identifier,
          subscriptionId: input.event.subscriptionId,
        },
      },
    },
  };
}

/**
 * Hydrate plain resource-event mailbox rows for a Slack-bound conversation.
 *
 * Destination and thread come from the conversation binding, not the watch.
 */
export async function hydrateSlackResourceEventRecords(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  destination?: Destination;
  records: InboundMessage[];
}): Promise<InboundMessage[]> {
  const needsHydration = args.records.some(
    (record) =>
      record.source === "resource_event" &&
      isResourceEventMailboxMetadata(record.input.metadata) &&
      !hasSlackConversationMetadata(record.input.metadata),
  );
  if (!needsHydration) {
    return args.records;
  }

  const routing = await resolveConversationRouting({
    conversationId: args.conversationId,
    conversationStore: args.conversationStore,
  });
  const destination = requireSlackDestination(
    routing?.destination ?? args.destination,
    "Slack resource-event hydration",
  );
  const threadTs =
    (routing?.source.platform === "slack"
      ? routing.source.threadTs?.trim()
      : undefined) ||
    parseSlackThreadId(args.conversationId)?.threadTs;
  if (!threadTs) {
    throw new Error(
      `Conversation ${args.conversationId} is missing a Slack thread for resource-event delivery`,
    );
  }

  return args.records.map((record) => {
    if (
      record.source !== "resource_event" ||
      !isResourceEventMailboxMetadata(record.input.metadata) ||
      hasSlackConversationMetadata(record.input.metadata)
    ) {
      return record;
    }
    return createSlackResourceEventInboundMessage({
      conversationId: record.conversationId,
      destination,
      event: record.input.metadata.resourceEvent,
      occurredAtMs: record.createdAtMs,
      receivedAtMs: record.receivedAtMs,
      text: record.input.text,
      threadTs,
    });
  });
}
