import type { Message } from "chat";
import { appendConversationMessages } from "@/chat/conversations/messages";
import { getConversationEventStore } from "@/chat/db";
import { recordSkippedConversationMessage } from "@/chat/runtime/conversation-message";
import { parseContent } from "@/chat/slack/message/content";
import { coerceThreadConversationState } from "@/chat/state/conversation";

/**
 * Save a Slack message that starts no Turn as a skipped Message, so later
 * Turns see it. A redelivery saves nothing new: the Message id is the
 * idempotency key.
 */
export async function saveSkippedSlackMessage(args: {
  conversationId: string;
  message: Message;
  skippedReason: string;
}): Promise<void> {
  const conversation = coerceThreadConversationState(undefined);
  recordSkippedConversationMessage({
    conversation,
    message: args.message,
    skippedReason: args.skippedReason,
    text: parseContent(args.message).text,
  });
  await appendConversationMessages(getConversationEventStore(), {
    conversation,
    conversationId: args.conversationId,
  });
}
