import type { Message } from "chat";
import type { AgentSteeringMessage } from "@/chat/agent/types";
import { createActor, parseActorUserId } from "@/chat/actor";
import {
  instructionProvenanceFor,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import {
  commitMessages,
  loadConversationProjection,
} from "@/chat/conversations/projection";
import type { PiMessage } from "@/chat/pi/messages";
import type { QueuedTurnMessage } from "@/chat/runtime/turn-input";
import {
  readSlackMessageAttachments,
  type SlackMessageAttachment,
} from "@/chat/slack/attachments";
import { getConversationInfo } from "@/chat/slack/channel";
import { SlackActionError } from "@/chat/slack/client";
import {
  resolveSlackChannelTypeFromMessage,
  slackChannelTypeFromConversationInfo,
  type SlackEventChannelType,
} from "@/chat/slack/conversation-context";
import { parseSlackChannelId } from "@/chat/slack/ids";
import { getMessageTimestamp } from "@/chat/slack/message/identity";
import { getMessageActorIdentity } from "@/chat/services/message-actor-identity";
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { withoutSavedSteeringMessages } from "@/chat/agent/prompt";

/** Return the actor stored with one inbound Slack message. */
export function inboundMessageActor(
  queued: QueuedTurnMessage,
): AgentSteeringMessage["actor"] {
  const actor = getMessageActorIdentity(queued.message);
  const authorId =
    actor?.userId ?? parseActorUserId(queued.message.author.userId);
  const authorName = actor?.fullName ?? actor?.userName;
  const slackTs = getMessageTimestamp(queued.message);
  return {
    ...(authorId ? { authorId } : undefined),
    ...(authorName ? { authorName } : undefined),
    ...(slackTs ? { slackTs } : undefined),
  };
}

/** Return the authority stored with one inbound Slack message. */
export function inboundMessageProvenance(
  queued: QueuedTurnMessage,
  teamId: string,
): ConversationMessageProvenance {
  const identity = getMessageActorIdentity(queued.message);
  const author =
    identity && "platform" in identity
      ? identity
      : createActor(
          { userId: parseActorUserId(queued.message.author.userId) },
          {
            platform: "slack",
            teamId,
            userId: parseActorUserId(queued.message.author.userId),
          },
        );
  return instructionProvenanceFor(author);
}

/** Slack channel facts for one Turn. */
export interface SlackChannelFacts {
  channelType?: SlackEventChannelType;
  name?: string;
  topic?: string;
  description?: string;
}

/**
 * Return the Slack channel type, name, topic, and description of a message
 * with one `conversations.info` call.
 *
 * Slack delivers a channel mention as two events with the same `ts`: `message`
 * has `channel_type`, and `app_mention` does not. Junior stores the event that
 * arrives first. When that event has no `channel_type`, the live conversation
 * metadata supplies it, so the turn does not depend on the order of the two
 * events.
 */
export async function resolveSlackChannelFacts(
  message: Message,
  channelId: string | undefined,
): Promise<SlackChannelFacts> {
  const eventChannelType = resolveSlackChannelTypeFromMessage(message);
  const slackChannelId = parseSlackChannelId(channelId);
  if (!slackChannelId) {
    return { channelType: eventChannelType };
  }
  try {
    const info = await getConversationInfo(slackChannelId);
    return {
      channelType:
        eventChannelType ?? slackChannelTypeFromConversationInfo(info),
      name: info.name,
      topic: info.topic,
      description: info.description,
    };
  } catch (error) {
    // Slack can refuse the lookup, for example when an install has no read
    // scope for this conversation. The turn then has no confirmed visibility.
    if (error instanceof SlackActionError) {
      return { channelType: eventChannelType };
    }
    throw error;
  }
}

/** Collect attachments from the current Slack message and its batch. */
export function collectAttachments(
  message: Message,
  batchedMessages?: QueuedTurnMessage[],
): SlackMessageAttachment[] {
  return [
    ...(batchedMessages ?? []).flatMap((queued) =>
      readSlackMessageAttachments(queued.message),
    ),
    ...readSlackMessageAttachments(message),
  ];
}

/**
 * Save each steering message once. Return false when a resumed Run is active
 * so the mailbox delivery stays pending.
 */
export async function saveSteeringMessages(args: {
  conversationId: string;
  messages: Array<{
    message: PiMessage;
    provenance: ConversationMessageProvenance;
  }>;
}): Promise<boolean> {
  if (args.messages.length === 0) {
    return true;
  }
  const state = getStateAdapter();
  await state.connect();
  const lock = await acquireActiveLock(state, args.conversationId);
  if (!lock) {
    return false;
  }
  try {
    const projection = await loadConversationProjection({
      conversationId: args.conversationId,
    });
    const missing = withoutSavedSteeringMessages(
      projection.messages,
      args.messages,
      (entry) => entry.message,
    );
    if (missing.length === 0) {
      return true;
    }
    await commitMessages({
      conversationId: args.conversationId,
      messages: [
        ...projection.messages,
        ...missing.map((entry) => entry.message),
      ],
      provenance: [
        ...projection.provenance,
        ...missing.map((entry) => entry.provenance),
      ],
    });
    return true;
  } finally {
    await state.releaseLock(lock);
  }
}
