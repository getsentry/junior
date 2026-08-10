import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";

/** Return whether web messages arrived after the prior Slack message. */
export function hasDashboardActivitySincePriorSlackMessage(
  conversation: ThreadConversationState,
  currentSlackMessageId: string | undefined,
): boolean {
  const currentIndex = currentSlackMessageId
    ? conversation.messages.findIndex(
        (message) => message.id === currentSlackMessageId,
      )
    : conversation.messages.length;
  const endIndex =
    currentIndex >= 0 ? currentIndex : conversation.messages.length;
  let priorSlackIndex = -1;

  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const message: ConversationMessage | undefined =
      conversation.messages[index];
    if (message?.meta?.slackTs) {
      priorSlackIndex = index;
      break;
    }
  }

  return conversation.messages
    .slice(priorSlackIndex + 1, endIndex)
    .some((message) => message.meta?.source === "web");
}
