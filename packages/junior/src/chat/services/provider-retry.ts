import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPiMessageRole,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";

const PROVIDER_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
const PROVIDER_ERROR_PREFIX = "AI provider error:";
const PROVIDER_RETRY_ERROR_NAME = "ProviderRetryError";
const NON_RETRYABLE_PROVIDER_ERROR_PATTERNS = [
  /invalid.?api.?key|no api key|authentication|authorization|permission|forbidden|credential/i,
  /context.?length|context.?window/i,
  /content.?policy|validation|bad request|\b(?:400|401|403)\b/i,
  /unsupported model|invalid model|unknown ai gateway model|unknown model|mismatched api/i,
  /usage limit|monthly usage limit|available balance|insufficient.?quota|out of budget|quota exceeded|billing/i,
] as const;

function providerMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim();
}

/** Mark failures that cross the AI provider boundary for shared retry handling. */
export function createProviderError(error: unknown): Error {
  const message = providerMessage(error);
  const displayMessage = `${PROVIDER_ERROR_PREFIX} ${message || "Unknown provider error"}`;
  const providerError = new Error(displayMessage, { cause: error });
  if (message && isRetryableProviderFailure(message)) {
    providerError.name = PROVIDER_RETRY_ERROR_NAME;
  }
  return providerError;
}

/** Return whether a provider-boundary error should be retried by the worker. */
export function isProviderRetryError(error: unknown): boolean {
  return error instanceof Error && error.name === PROVIDER_RETRY_ERROR_NAME;
}

/** Classify upstream failures by exclusion so new transient provider errors retry. */
function isRetryableProviderFailure(errorMessage: string): boolean {
  return !NON_RETRYABLE_PROVIDER_ERROR_PATTERNS.some((pattern) =>
    pattern.test(errorMessage),
  );
}

/** Build the next provider retry step from Pi history, if the turn can resume. */
export function nextProviderRetry(args: {
  attempt: number;
  lastAssistant:
    | Pick<AssistantMessage, "stopReason" | "errorMessage">
    | undefined;
  messages: PiMessage[];
}): { delayMs: number; messages: PiMessage[] } | undefined {
  const delayMs = PROVIDER_RETRY_DELAYS_MS[args.attempt];
  const errorMessage = args.lastAssistant?.errorMessage?.trim();
  if (
    delayMs === undefined ||
    args.lastAssistant?.stopReason !== "error" ||
    !errorMessage ||
    !isRetryableProviderFailure(errorMessage)
  ) {
    return undefined;
  }

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
