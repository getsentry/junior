import type { Message, Thread } from "chat";
import type { AgentSteeringMessage } from "@/chat/agent/types";
import { createActor, parseActorUserId } from "@/chat/actor";
import {
  contextProvenance,
  instructionProvenanceFor,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import { isResourceEventSlackMessage } from "@/chat/resource-events/actor";
import type { QueuedTurnMessage } from "@/chat/runtime/turn-input";
import { getMessageTimestamp } from "@/chat/slack/message/identity";
import { appendThreadContextMessages } from "@/chat/services/conversation-memory";
import { getMessageActorIdentity } from "@/chat/services/message-actor-identity";
import { escapeXml } from "@/chat/xml";

function renderRecentThreadMessageLines(
  conversationContext: string | undefined,
  messages: QueuedTurnMessage[],
): string[] {
  const passiveMessages = messages.filter((queued) => {
    if (queued.explicitMention) {
      return false;
    }
    const slackTs = queuedInstructionActor(queued)?.slackTs;
    return !slackTs || !conversationContext?.includes(`slack_ts="${slackTs}"`);
  });
  if (passiveMessages.length === 0) {
    return [];
  }
  const lines: string[] = [];
  for (const queued of passiveMessages) {
    const actor = queuedInstructionActor(queued);
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

/** Add recent passive Slack messages to the agent context. */
export function appendRecentMessagesToContext(
  conversationContext: string | undefined,
  messages: QueuedTurnMessage[],
  options?: { includeConversationContext?: boolean },
): string | undefined {
  const baseContext =
    options?.includeConversationContext === false
      ? undefined
      : conversationContext;
  return appendThreadContextMessages(
    baseContext,
    renderRecentThreadMessageLines(conversationContext, messages),
  );
}

/** Return the actor data stored with one queued Slack instruction. */
export function queuedInstructionActor(
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

/** Return the authority stored with one queued Slack instruction. */
export function queuedInstructionProvenance(
  queued: QueuedTurnMessage,
  teamId: string,
): ConversationMessageProvenance {
  if (isResourceEventSlackMessage(queued.message)) {
    return contextProvenance;
  }
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

/** Collect attachments from the active and queued Slack messages. */
export function collectAttachments(
  message: Message,
  queuedMessages?: QueuedTurnMessage[],
): Message["attachments"] {
  return [
    ...(queuedMessages ?? []).flatMap((queued) => queued.message.attachments),
    ...message.attachments,
  ];
}
