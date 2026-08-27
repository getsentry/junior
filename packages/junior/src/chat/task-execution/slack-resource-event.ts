/**
 * Slack edge helpers for resource-event mailbox wakes.
 *
 * Resource-event ingest stores plain conversation mailbox input. When the
 * conversation destination is Slack, this module builds the Message and Thread
 * the Slack runtime needs for one turn. It does not rewrite mailbox rows.
 */
import { Message, ThreadImpl, type StateAdapter } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import type { Destination, SlackDestination } from "@sentry/junior-plugin-api";
import type { ConversationStore } from "@/chat/conversations/store";
import { requireSlackDestination } from "@/chat/destination";
import {
  normalizeIncomingSlackThreadId,
  withNormalizedThreadId,
} from "@/chat/ingress/message-router";
import { RESOURCE_EVENT_AUTHOR_ID } from "@/chat/resource-events/actor";
import { isResourceEventMailboxMetadata } from "@/chat/resource-events/notification";
import { resolveConversationRouting } from "@/chat/services/turn-session-routing";
import type { InboundMessage } from "@/chat/task-execution/store";

/** Load Slack destination and threadTs for a resource-event wake. */
export async function resolveSlackResourceEventThread(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  destination?: Destination;
}): Promise<{ destination: SlackDestination; threadTs: string }> {
  const routing = await resolveConversationRouting({
    conversationId: args.conversationId,
    conversationStore: args.conversationStore,
  });
  const destination = requireSlackDestination(
    routing?.destination ?? args.destination,
    "Slack resource-event turn",
  );
  const threadTs =
    routing?.source?.platform === "slack"
      ? routing.source.threadTs?.trim()
      : undefined;
  if (!threadTs) {
    throw new Error(
      `Conversation ${args.conversationId} is missing a Slack thread for resource-event delivery`,
    );
  }
  return { destination, threadTs };
}

/** Whether a mailbox row is a plain resource-event wake (no Slack envelope). */
export function isPlainResourceEventRecord(record: InboundMessage): boolean {
  return (
    record.source === "resource_event" &&
    isResourceEventMailboxMetadata(record.input.metadata) &&
    !hasSlackConversationMetadata(record.input.metadata)
  );
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
 * Build a Slack Message for one plain resource-event mailbox row.
 *
 * Used only at the Slack worker edge. The mailbox row stays plain.
 */
export function buildResourceEventSlackMessage(args: {
  channelId: string;
  record: InboundMessage;
  threadTs: string;
}): Message {
  if (!isResourceEventMailboxMetadata(args.record.input.metadata)) {
    throw new Error(
      "Resource-event Slack turn requires resource-event metadata",
    );
  }
  const event = args.record.input.metadata.resourceEvent;
  const messageId = `resource-event-${event.subscriptionId}-${event.eventKey}`;
  const threadId = `slack:${args.channelId}:${args.threadTs}`;
  return new Message({
    id: messageId,
    threadId,
    text: args.record.input.text,
    author: {
      userId: RESOURCE_EVENT_AUTHOR_ID,
      userName: "junior-event",
      fullName: "Junior event",
      isBot: true,
      isMe: false,
    },
    isMention: false,
    attachments: [],
    metadata: {
      dateSent: new Date(args.record.createdAtMs),
      edited: false,
    },
    formatted: { type: "root", children: [] },
    raw: {
      channel: args.channelId,
      event_type: "resource_event",
      resource_event_type: event.eventType,
      thread_ts: args.threadTs,
      type: "message",
      user: RESOURCE_EVENT_AUTHOR_ID,
    },
  });
}

/** Build a ThreadImpl for a resource-event Slack turn. */
export function buildResourceEventSlackThread(args: {
  adapter: SlackAdapter;
  message: Message;
  state: StateAdapter;
  threadTs: string;
  channelId: string;
}): ThreadImpl {
  const threadId = normalizeIncomingSlackThreadId(
    `slack:${args.channelId}:${args.threadTs}`,
    args.message,
  );
  const message = withNormalizedThreadId(args.message, threadId);
  return new ThreadImpl({
    adapter: args.adapter,
    stateAdapter: args.state,
    id: threadId,
    channelId: args.channelId,
    currentMessage: message,
    initialMessage: message,
    isDM: args.channelId.startsWith("D"),
    isSubscribedContext: true,
  });
}
