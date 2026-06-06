import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPiMessageRole,
  trimTrailingAssistantMessages,
} from "@/chat/respond-helpers";

const RETRYABLE_PROVIDER_ERROR_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

const NON_RETRYABLE_PROVIDER_ERROR_PATTERN =
  /invalid.?api.?key|authentication|authorization|permission|forbidden|context.?length|context.?window|content.?policy|validation|bad request|400|401|403/i;

/** Detect transient provider failures that are safe to retry from a Pi boundary. */
export function isRetryableProviderError(
  message: Pick<AssistantMessage, "stopReason" | "errorMessage"> | undefined,
): boolean {
  if (message?.stopReason !== "error" || !message.errorMessage) {
    return false;
  }
  if (NON_RETRYABLE_PROVIDER_ERROR_PATTERN.test(message.errorMessage)) {
    return false;
  }
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(message.errorMessage);
}

/** Remove a failed assistant tail only when the remaining Pi history can continue. */
export function trimRetryableProviderErrorTail(
  messages: PiMessage[],
): PiMessage[] | undefined {
  const trimmed = trimTrailingAssistantMessages(messages);
  if (trimmed.length === messages.length) {
    return undefined;
  }

  const tailRole = getPiMessageRole(trimmed.at(-1));
  return tailRole === "user" || tailRole === "toolResult" ? trimmed : undefined;
}
