import type { PiMessage } from "@/chat/pi/messages";
import {
  getPiMessageRole,
  isAssistantMessage,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import { getToolActionRejectionMarker } from "@/chat/tool-support/action-review-history";

/**
 * Return the durable tool-result boundary for one additional agent
 * continuation when an ask rejection has no destination-visible reply.
 */
export function actionConfirmationRetryMessages(
  messages: readonly PiMessage[],
): PiMessage[] | undefined {
  let rejectionIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = getToolActionRejectionMarker(messages[index]);
    if (candidate) {
      if (candidate.decision === "deny") {
        return undefined;
      }
      rejectionIndex = index;
      break;
    }
  }
  if (rejectionIndex < 0) {
    return undefined;
  }
  if (
    messages.slice(rejectionIndex + 1).some((message) => {
      if (message.role === "user") {
        return true;
      }
      return (
        isAssistantMessage(message) &&
        getAssistantReplyText(message)
      );
    })
  ) {
    return undefined;
  }

  const retryMessages = trimTrailingAssistantMessages([...messages]);
  if (getPiMessageRole(retryMessages.at(-1)) !== "toolResult") {
    return undefined;
  }
  return retryMessages;
}
