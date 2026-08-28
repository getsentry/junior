import type { Message, Thread } from "chat";
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
import { getMessageTimestamp } from "@/chat/slack/message/identity";
import { appendThreadContextMessages } from "@/chat/services/conversation-memory";
import { getMessageActorIdentity } from "@/chat/services/message-actor-identity";
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { escapeXml } from "@/chat/xml";

/**
 * Return a stable key for one steering message. Resolved attachments may change
 * when Junior retries a mailbox delivery, so only the message time and text
 * form the key.
 */
export function steeringMessageKey(message: PiMessage): string | undefined {
  if (message.role !== "user") {
    return undefined;
  }
  const first = Array.isArray(message.content) ? message.content[0] : undefined;
  const text =
    first && typeof first === "object" && "text" in first
      ? String((first as { text?: unknown }).text ?? "")
      : "";
  return `${message.timestamp}:${text}`;
}

function renderRecentThreadMessageLines(
  conversationContext: string | undefined,
  messages: QueuedTurnMessage[],
): string[] {
  const messagesForContext = messages.filter((queued) => {
    if (queued.explicitMention) {
      return false;
    }
    const slackTs = inboundMessageActor(queued)?.slackTs;
    return !slackTs || !conversationContext?.includes(`slack_ts="${slackTs}"`);
  });
  if (messagesForContext.length === 0) {
    return [];
  }
  const lines: string[] = [];
  for (const queued of messagesForContext) {
    const actor = inboundMessageActor(queued);
    const author = escapeXml(actor?.authorName ?? "user");
    const attrs = [
      `role="user"`,
      `author="${author}"`,
      actor?.authorId ? `actor_id="${escapeXml(actor.authorId)}"` : undefined,
      actor?.slackTs ? `slack_ts="${escapeXml(actor.slackTs)}"` : undefined,
    ]
      .filter((attr): attr is string => Boolean(attr))
      .join(" ");
    const text = escapeXml(queued.userText.replace(/\s+/g, " "));
    lines.push(
      `  <message ${attrs}>`,
      `[user] ${author}: ${text}`,
      "  </message>",
    );
  }
  return lines;
}

/** Add recent Slack messages to the agent context. */
export function appendRecentMessagesToContext(
  conversationContext: string | undefined,
  messages: QueuedTurnMessage[],
): string | undefined {
  return appendThreadContextMessages(
    conversationContext,
    renderRecentThreadMessageLines(conversationContext, messages),
  );
}

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

/** Return the Slack channel name when it is available. */
export async function resolveChannelName(
  thread: Thread,
): Promise<string | undefined> {
  const existingName = thread.channel.name?.trim();
  if (existingName) {
    return existingName;
  }

  try {
    const metadata = await thread.channel.fetchMetadata();
    return metadata.name?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Collect attachments from the current Slack message and its batch. */
export function collectAttachments(
  message: Message,
  batchedMessages?: QueuedTurnMessage[],
): Message["attachments"] {
  return [
    ...(batchedMessages ?? []).flatMap((queued) => queued.message.attachments),
    ...message.attachments,
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
    // A repeated mailbox delivery can contain saved and unsaved messages.
    const savedKeys = new Set(
      projection.messages
        .map(steeringMessageKey)
        .filter((key): key is string => key !== undefined),
    );
    const missing = args.messages.filter((entry) => {
      const key = steeringMessageKey(entry.message);
      return key === undefined || !savedKeys.has(key);
    });
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
