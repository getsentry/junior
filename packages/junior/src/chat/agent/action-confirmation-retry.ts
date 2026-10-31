import { REPORT_BLOCKED_TOOL_NAME } from "@/chat/agent-invocations/blocked-report";
import { FINISH_AUTOMATION_RUN_TOOL_NAME } from "@/chat/automation-result";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPiMessageRole,
  isAssistantMessage,
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import { getToolActionRejectionMarker } from "@/chat/guardian/history";

// A successful result of one of these tools ends the run on purpose, so the
// run has its outcome even without a reply.
const RUN_ENDING_TOOL_NAMES = new Set([
  FINISH_AUTOMATION_RUN_TOOL_NAME,
  REPORT_BLOCKED_TOOL_NAME,
]);

function endsRun(message: PiMessage): boolean {
  return (
    isToolResultMessage(message) &&
    !isToolResultError(message) &&
    RUN_ENDING_TOOL_NAMES.has(normalizeToolNameFromResult(message) ?? "")
  );
}

/**
 * Return the durable tool-result boundary for one additional agent
 * continuation when an ask rejection has no destination-visible reply. A run
 * that a blocked report or an Automation result ended gets none. An ask with
 * a review desk item gets none, because the item is the question.
 */
export function actionConfirmationRetryMessages(
  messages: readonly PiMessage[],
): PiMessage[] | undefined {
  let rejectionIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = getToolActionRejectionMarker(messages[index]);
    if (candidate) {
      if (candidate.decision === "deny" || candidate.reviewItemId) {
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
      if (message.role === "user" || endsRun(message)) {
        return true;
      }
      return isAssistantMessage(message) && getAssistantReplyText(message);
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
