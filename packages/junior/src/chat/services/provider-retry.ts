import {
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { PiMessage } from "@/chat/pi/messages";
import {
  createProviderError,
  type ProviderError,
} from "@/chat/services/provider-error";
import {
  getPiMessageRole,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";

const PROVIDER_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
const MAX_PROVIDER_RETRY_DELAY_MS = 60_000;

/** Apply Junior's retry budget to a retryable Pi assistant failure. */
export function nextProviderRetry(args: {
  attempt: number;
  failure?: AssistantMessage;
  messages: PiMessage[];
}):
  | {
      delayMs: number;
      messages: PiMessage[];
      providerError: ProviderError;
    }
  | undefined {
  const backoffMs = PROVIDER_RETRY_DELAYS_MS[args.attempt];
  const errorMessage = args.failure?.errorMessage;
  if (backoffMs === undefined || !args.failure || !errorMessage) {
    return undefined;
  }

  const providerError = createProviderError(errorMessage, {
    retryable: true,
  });
  const hasRetrySignal =
    isRetryableAssistantError(args.failure) || providerError.status === 408;
  if (!hasRetrySignal || !providerError.retryable) {
    return undefined;
  }
  const delayMs = Math.min(
    MAX_PROVIDER_RETRY_DELAY_MS,
    Math.max(backoffMs, providerError.retryAfterMs ?? 0),
  );

  const messages = trimTrailingAssistantMessages(args.messages);
  if (messages.length === args.messages.length) {
    return undefined;
  }

  const tailRole = getPiMessageRole(messages.at(-1));
  if (tailRole !== "user" && tailRole !== "toolResult") {
    return undefined;
  }

  return { delayMs, messages, providerError };
}
