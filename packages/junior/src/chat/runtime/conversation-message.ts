import type { Message } from "chat";
import { getMessageTimestamp } from "@/chat/slack/message/identity";
import type { ConversationMessage } from "@/chat/state/conversation";
import { normalizeConversationText } from "@/chat/services/conversation-memory";
import { getMessageActorIdentity } from "@/chat/services/message-actor-identity";
import {
  countPotentialImageAttachments,
  hasPotentialImageAttachment,
} from "@/chat/slack/vision-context";

const NON_TEXT_MESSAGE_TEXT = "[non-text message]";

interface ConversationMessageInput {
  entry: Message;
  explicitMention?: boolean;
  text: string;
}

function resourceEventType(entry: Message): string | undefined {
  if (!entry.raw || typeof entry.raw !== "object") return undefined;
  const raw = entry.raw as Record<string, unknown>;
  return raw.event_type === "resource_event" &&
    typeof raw.resource_event_type === "string"
    ? raw.resource_event_type
    : undefined;
}

function resolveMessageText(args: ConversationMessageInput): string {
  const text = normalizeConversationText(args.text);
  return text || NON_TEXT_MESSAGE_TEXT;
}

/** Preserve an SDK message and its Slack metadata in durable conversation memory. */
export function toConversationMessage(
  args: ConversationMessageInput,
): ConversationMessage {
  const actor = getMessageActorIdentity(args.entry);
  const slackTs = getMessageTimestamp(args.entry);
  const messageHasPotentialImageAttachment = hasPotentialImageAttachment(
    args.entry.attachments,
  );
  const imageAttachmentCount = messageHasPotentialImageAttachment
    ? countPotentialImageAttachments(args.entry.attachments)
    : 0;

  return {
    id: args.entry.id,
    role: args.entry.author.isMe ? "assistant" : "user",
    text: resolveMessageText(args),
    createdAtMs: args.entry.metadata.dateSent.getTime(),
    author: {
      ...(actor?.userId ? { userId: actor.userId } : undefined),
      ...(actor?.userName ? { userName: actor.userName } : undefined),
      ...(actor?.fullName ? { fullName: actor.fullName } : undefined),
      isBot:
        typeof args.entry.author.isBot === "boolean"
          ? args.entry.author.isBot
          : undefined,
    },
    meta: {
      attachmentCount: args.entry.attachments.length,
      eventType: resourceEventType(args.entry),
      explicitMention: args.explicitMention,
      imageAttachmentCount:
        imageAttachmentCount > 0 ? imageAttachmentCount : undefined,
      imagesHydrated: !messageHasPotentialImageAttachment,
      source: "slack",
      ...(slackTs ? { slackTs } : undefined),
    },
  };
}
