import type { AssistantMessage } from "@earendil-works/pi-ai";
import { commitAcceptedReply } from "@/chat/conversations/projection";
import { logException } from "@/chat/logging";
import { recordDeliveredAssistantMessage } from "@/chat/services/conversation-memory";
import { persistWithRetry } from "@/chat/services/persist-retry";
import type { ThreadConversationState } from "@/chat/state/conversation";

/** Record a web-accepted assistant reply with agent history before the visible message. */
export async function commitWebAcceptedReply(args: {
  agentMessage?: AssistantMessage;
  conversation: ThreadConversationState;
  conversationId: string;
  sessionId: string;
  text: string;
  userMessageId: string;
}): Promise<void> {
  const conversationMessageId = recordDeliveredAssistantMessage({
    conversation: args.conversation,
    sessionId: args.sessionId,
    source: "web",
    text: args.text,
    userMessageId: args.userMessageId,
  });
  try {
    await persistWithRetry(() =>
      commitAcceptedReply({
        ...(args.agentMessage ? { agentMessage: args.agentMessage } : undefined),
        conversation: args.conversation,
        conversationMessageId,
        conversationId: args.conversationId,
      }),
    );
  } catch (error) {
    logException(
      new Error("Accepted assistant message persistence failed"),
      "api.assistant.message_post_delivery_persist.failed",
      {
        "error.type": error instanceof Error ? error.name : typeof error,
      },
    );
  }
}
