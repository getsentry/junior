import type { Message } from "chat";
import { getSlackMessageTs } from "@/chat/slack/message";
import type { ConversationMessage } from "@/chat/state/conversation";
import { normalizeConversationText } from "@/chat/services/conversation-memory";
import { getMessageActorIdentity } from "@/chat/services/message-actor-identity";
import {
  countPotentialImageAttachments,
  hasPotentialImageAttachment,
} from "@/chat/services/vision-context";

const NON_TEXT_MESSAGE_TEXT = "[non-text message]";

interface ConversationMessageInput {
  entry: Message;
  explicitMention?: boolean;
  text: string;
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
      ...(actor?.userId ? { userId: actor.userId } : {}),
      ...(actor?.userName ? { userName: actor.userName } : {}),
      ...(actor?.fullName ? { fullName: actor.fullName } : {}),
      isBot:
        typeof args.entry.author.isBot === "boolean"
          ? args.entry.author.isBot
          : undefined,
    },
    meta: {
      attachmentCount: args.entry.attachments.length,
      explicitMention: args.explicitMention,
      imageAttachmentCount:
        imageAttachmentCount > 0 ? imageAttachmentCount : undefined,
      imagesHydrated: !messageHasPotentialImageAttachment,
      slackTs: getSlackMessageTs(args.entry),
    },
  };
}
