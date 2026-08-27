import type { AssistantMessage } from "@earendil-works/pi-ai";
import { commitAcceptedReply } from "@/chat/conversations/projection";
import { logException } from "@/chat/logging";
import { recordDeliveredAssistantMessage } from "@/chat/services/conversation-memory";
import { persistWithRetry } from "@/chat/services/persist-retry";
import type { ThreadConversationState } from "@/chat/state/conversation";

/** Store one assistant Message and its Agent history. */
export async function commitAssistantMessage(args: {
  agentMessage?: AssistantMessage;
  conversation: ThreadConversationState;
  conversationId: string;
  sessionId: string;
  source?: "web";
  text: string;
  userMessageId: string;
}): Promise<void> {
  const conversationMessageId = recordDeliveredAssistantMessage({
    conversation: args.conversation,
    sessionId: args.sessionId,
    source: args.source,
    text: args.text,
    userMessageId: args.userMessageId,
  });
  try {
    await persistWithRetry(() =>
      commitAcceptedReply({
        ...(args.agentMessage
          ? { agentMessage: args.agentMessage }
          : undefined),
        conversation: args.conversation,
        conversationMessageId,
        conversationId: args.conversationId,
      }),
    );
  } catch (error) {
    logException(
      new Error("Assistant message persistence failed"),
      "conversation.assistant.message_persist.failed",
      {
        "error.type": error instanceof Error ? error.name : typeof error,
      },
    );
  }
}
