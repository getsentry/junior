/**
 * Shared builders for synthetic internal mailbox wakes.
 *
 * Resource-event notifications and agent-invocation parent results both land as
 * durable inbound messages with:
 * - a stable inboundMessageId
 * - kind + durable reference metadata
 * - rendered text the parent turn consumes
 * - a Slack envelope when the destination is Slack (ordinary Slack roots and
 *   destination-bearing parents such as agent-dispatch)
 *
 * Authority is not encoded here. Resource events run as the resource-event
 * system principal; agent-invocation results restore actor + credentialContext
 * from the durable invocation.
 */
import type { Destination } from "@sentry/junior-plugin-api";
import type { SerializedMessage, SerializedThread } from "chat";
import { AGENT_INVOCATION_RESULT_SLACK_AUTHOR_ID } from "@/chat/agent-invocations/actor";
import { RESOURCE_EVENT_SLACK_AUTHOR_ID } from "@/chat/resource-events/actor";
import type { InboundMessage } from "@/chat/task-execution/store";

function parseSlackConversationId(
  conversationId: string,
): { channelId: string; threadTs: string } | undefined {
  const parts = conversationId.split(":");
  if (parts.length !== 3 || parts[0] !== "slack" || !parts[1] || !parts[2]) {
    return undefined;
  }
  return { channelId: parts[1], threadTs: parts[2] };
}

function slackSerializedThread(input: {
  channelId: string;
  message: SerializedMessage;
  threadId: string;
}): SerializedThread {
  return {
    _type: "chat:Thread",
    adapterName: "slack",
    channelId: input.channelId,
    currentMessage: input.message,
    id: input.threadId,
    isDM: input.channelId.startsWith("D"),
  };
}

function slackSerializedSyntheticMessage(input: {
  authorId: string;
  authorUserName: string;
  authorFullName: string;
  channelId: string;
  eventType: "agent_invocation_result" | "resource_event";
  extraRaw?: Record<string, unknown>;
  id: string;
  text: string;
  threadId: string;
  threadTs?: string;
  timestampIso: string;
}): SerializedMessage {
  return {
    _type: "chat:Message",
    attachments: [],
    author: {
      userId: input.authorId,
      userName: input.authorUserName,
      fullName: input.authorFullName,
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
      event_type: input.eventType,
      type: "message",
      user: input.authorId,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(input.extraRaw ?? {}),
    },
    text: input.text,
    threadId: input.threadId,
  };
}

function requireSlackDestination(
  destination: Destination,
  label: string,
): Extract<Destination, { platform: "slack" }> {
  if (destination.platform !== "slack") {
    throw new Error(`${label} requires a Slack destination`);
  }
  return destination;
}

/**
 * Build parent-mailbox input for one terminal agent-invocation result.
 *
 * Parent conversation id is always the mailbox conversation identity. When the
 * destination is Slack, attach the same synthetic envelope shape resource
 * events use so the shared Slack worker can restore the turn — including for
 * agent-dispatch parents whose conversation id is not `slack:channel:threadTs`.
 * Local parents keep the simple kind + reference metadata wake.
 */
export function createAgentInvocationResultInboundMessage(input: {
  createdAtMs: number;
  destination: Destination;
  inboundMessageId: string;
  invocationId: string;
  parentConversationId: string;
  receivedAtMs: number;
  text: string;
}): InboundMessage {
  const base = {
    conversationId: input.parentConversationId,
    createdAtMs: input.createdAtMs,
    delivery: "defer" as const,
    destination: input.destination,
    inboundMessageId: input.inboundMessageId,
    receivedAtMs: input.receivedAtMs,
    source: "internal" as const,
  };
  const referenceMetadata = {
    agentInvocationId: input.invocationId,
    kind: "agent_invocation_result" as const,
  };

  if (input.destination.platform !== "slack") {
    return {
      ...base,
      input: {
        authorId: input.invocationId,
        text: input.text,
        metadata: referenceMetadata,
      },
    };
  }

  const destination = requireSlackDestination(
    input.destination,
    "Agent invocation result delivery",
  );
  const slackParent = parseSlackConversationId(input.parentConversationId);
  if (slackParent && destination.channelId !== slackParent.channelId) {
    throw new Error(
      "Agent invocation destination does not match Slack parent conversation",
    );
  }

  const channelId = destination.channelId;
  const threadTs = slackParent?.threadTs;
  const timestampIso = new Date(input.createdAtMs).toISOString();
  const message = slackSerializedSyntheticMessage({
    authorId: AGENT_INVOCATION_RESULT_SLACK_AUTHOR_ID,
    authorUserName: "junior-agent",
    authorFullName: "Junior agent",
    channelId,
    eventType: "agent_invocation_result",
    extraRaw: {
      agent_invocation_id: input.invocationId,
    },
    id: input.inboundMessageId,
    text: input.text,
    threadId: input.parentConversationId,
    ...(threadTs ? { threadTs } : {}),
    timestampIso,
  });
  const thread = slackSerializedThread({
    channelId,
    message,
    threadId: input.parentConversationId,
  });
  return {
    ...base,
    input: {
      text: input.text,
      authorId: AGENT_INVOCATION_RESULT_SLACK_AUTHOR_ID,
      metadata: {
        ...referenceMetadata,
        installation: {
          teamId: destination.teamId,
        },
        platform: "slack",
        route: "subscribed",
        thread,
        message,
      },
    },
  };
}

/** Build mailbox input for one subscribed resource-event notification. */
export function createResourceEventInboundMessage(input: {
  event: {
    eventKey: string;
    eventType: string;
    occurredAtMs: number;
    namespace: string;
    identifier: string;
  };
  subscription: {
    conversationId: string;
    destination: Destination;
    id: string;
  };
  text: string;
}): InboundMessage {
  const slackParent = parseSlackConversationId(input.subscription.conversationId);
  if (!slackParent) {
    throw new Error(
      "Resource event delivery currently requires a Slack conversation",
    );
  }
  const destination = requireSlackDestination(
    input.subscription.destination,
    "Resource event delivery",
  );
  if (destination.channelId !== slackParent.channelId) {
    throw new Error(
      "Resource event subscription destination does not match Slack conversation",
    );
  }

  const messageId = `resource-event-${input.subscription.id}-${input.event.eventKey}`;
  const timestampIso = new Date(input.event.occurredAtMs).toISOString();
  const message = slackSerializedSyntheticMessage({
    authorId: RESOURCE_EVENT_SLACK_AUTHOR_ID,
    authorUserName: "junior-event",
    authorFullName: "Junior event",
    channelId: slackParent.channelId,
    eventType: "resource_event",
    extraRaw: {
      resource_event_type: input.event.eventType,
    },
    id: messageId,
    text: input.text,
    threadId: input.subscription.conversationId,
    threadTs: slackParent.threadTs,
    timestampIso,
  });
  const thread = slackSerializedThread({
    channelId: slackParent.channelId,
    message,
    threadId: input.subscription.conversationId,
  });
  return {
    conversationId: input.subscription.conversationId,
    createdAtMs: input.event.occurredAtMs,
    destination,
    inboundMessageId: `resource-event:${input.subscription.id}:${input.event.eventKey}`,
    delivery: "defer",
    source: "resource_event",
    receivedAtMs: Date.now(),
    input: {
      text: input.text,
      authorId: RESOURCE_EVENT_SLACK_AUTHOR_ID,
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
          subscriptionId: input.subscription.id,
        },
      },
    },
  };
}
