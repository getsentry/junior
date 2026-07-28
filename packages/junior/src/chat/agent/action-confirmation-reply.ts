import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiMessage } from "@/chat/pi/messages";
import { isAssistantMessage } from "@/chat/pi/transcript";
import { getAssistantMessageText } from "@/chat/services/turn-result";
import { getToolActionRejectionMarker } from "@/chat/tool-support/action-review-history";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function confirmationQuestion(reason: string): string {
  const explanation = reason
    .trim()
    .replace(/^(?:The )?user has\b/i, "You have")
    .replace(/^(?:The )?user is\b/i, "You are")
    .replace(/^(?:The )?user was\b/i, "You were")
    .replace(/^(?:The )?user\b/i, "You");
  return [
    `I haven't performed the action. ${explanation}`,
    "Should I perform that exact action?",
  ].join("\n\n");
}

/**
 * Build a durable confirmation reply when an ask rejection has no later
 * destination-visible assistant message.
 */
export function buildActionConfirmationReply(
  messages: readonly PiMessage[],
): AssistantMessage | undefined {
  let rejectionIndex = -1;
  let rejection: ReturnType<typeof getToolActionRejectionMarker> | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = getToolActionRejectionMarker(messages[index]);
    if (candidate) {
      if (candidate.decision === "deny") {
        return undefined;
      }
      rejectionIndex = index;
      rejection = candidate;
      break;
    }
  }
  if (!rejection) {
    return undefined;
  }
  if (
    messages.slice(rejectionIndex + 1).some((message) => {
      if (message.role === "user") {
        return true;
      }
      return isAssistantMessage(message) && getAssistantMessageText(message);
    })
  ) {
    return undefined;
  }

  let template: AssistantMessage | undefined;
  for (let index = rejectionIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (isAssistantMessage(candidate)) {
      template = candidate;
      break;
    }
  }
  if (!template) {
    return undefined;
  }
  return {
    role: "assistant",
    api: template.api,
    provider: template.provider,
    model: template.model,
    content: [
      {
        type: "text",
        text: confirmationQuestion(rejection.reason),
      },
    ],
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
