import type { PiMessage } from "@/chat/pi/messages";
import { isAssistantMessage } from "@/chat/pi/transcript";
import { extractGenAiUsageSummary } from "@/chat/logging";
import { hasAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";

/**
 * Return usage discarded when a retry keeps an exact prefix of agent history.
 *
 * Retained messages stay in the next phase and must not be counted again here.
 */
export function getDiscardedRetryUsage(
  messages: PiMessage[],
  retryMessages: PiMessage[],
): AgentTurnUsage | undefined {
  const keepsExactPrefix =
    retryMessages.length <= messages.length &&
    retryMessages.every((message, index) => message === messages[index]);
  if (!keepsExactPrefix) {
    throw new Error("Agent retry must retain an exact message prefix");
  }

  const usage = extractGenAiUsageSummary(
    ...messages.slice(retryMessages.length).filter(isAssistantMessage),
  );
  return hasAgentTurnUsage(usage) ? usage : undefined;
}
