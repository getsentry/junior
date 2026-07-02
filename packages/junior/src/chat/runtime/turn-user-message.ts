import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

/** Return the user message for a persisted turn/session, if one exists. */
export function getTurnUserMessage(
  conversation: ThreadConversationState,
  sessionId: string,
): ConversationMessage | undefined {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message?.role !== "user") {
      continue;
    }
    if (buildDeterministicTurnId(message.id) === sessionId) {
      return message;
    }
  }

  return undefined;
}

/** Return the persisted user-message id for a turn/session, if one exists. */
export function getTurnUserMessageId(
  conversation: ThreadConversationState,
  sessionId: string,
): string | undefined {
  return getTurnUserMessage(conversation, sessionId)?.id;
}

/** Return the Slack timestamp for the user message that a resumed turn acts on. */
export function getTurnUserSlackMessageTs(
  message: ConversationMessage | undefined,
): SlackMessageTs | undefined {
  return parseSlackMessageTs(message?.meta?.slackTs);
}

/** Rebuild attachment context for a resumed turn from the persisted user message. */
export function getTurnUserReplyAttachmentContext(
  message: ConversationMessage | undefined,
): {
  inboundAttachmentCount?: number;
  omittedImageAttachmentCount?: number;
} {
  const inboundAttachmentCount = message?.meta?.attachmentCount ?? 0;
  const imageAttachmentCount = message?.meta?.imageAttachmentCount ?? 0;
  const imagesHydrated = message?.meta?.imagesHydrated === true;

  return {
    ...(inboundAttachmentCount > 0 ? { inboundAttachmentCount } : {}),
    ...(!imagesHydrated && imageAttachmentCount > 0
      ? { omittedImageAttachmentCount: imageAttachmentCount }
      : {}),
  };
}
