import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";

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
