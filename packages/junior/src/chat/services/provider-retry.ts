import type { PiMessage } from "@/chat/pi/messages";
import { createProviderError } from "@/chat/services/provider-error";
import {
  getPiMessageRole,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";

const PROVIDER_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
const MAX_PROVIDER_RETRY_DELAY_MS = 60_000;

/** Build the next provider retry step from Pi history, if the turn can resume. */
export function nextProviderRetry(args: {
  attempt: number;
  failure?: { stopReason?: string; errorMessage?: string };
  messages: PiMessage[];
}): { delayMs: number; messages: PiMessage[] } | undefined {
  const backoffMs = PROVIDER_RETRY_DELAYS_MS[args.attempt];
  if (
    backoffMs === undefined ||
    args.failure?.stopReason !== "error" ||
    !args.failure.errorMessage
  ) {
    return undefined;
  }

  const providerError = createProviderError(args.failure.errorMessage);
  if (!providerError.retryable) {
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

  return { delayMs, messages };
}
