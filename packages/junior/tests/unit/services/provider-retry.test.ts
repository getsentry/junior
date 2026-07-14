import { describe, expect, it } from "vitest";
import {
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { PiMessage } from "@/chat/pi/messages";
import {
  nextProviderRetry,
  createProviderError,
  isProviderRetryError,
} from "@/chat/services/provider-retry";

function assistantError(errorMessage: string | undefined): AssistantMessage {
  return fauxAssistantMessage([], {
    stopReason: "error",
    ...(errorMessage ? { errorMessage } : {}),
  });
}

const XAI_SERVICE_UNAVAILABLE =
  '503 {"error":{"message":"Service temporarily unavailable. Please try again shortly.","type":"service_unavailable_error","param":{"error":"Service temporarily unavailable. Please try again shortly.","type":"service_unavailable_error","statusCode":503}},"providerMetadata":{"gateway":{"routing":{"originalModelId":"xai/grok-4.5","resolvedProvider":"xai","fallbacksAvailable":[],"canonicalSlug":"xai/grok-4.5","modelAttemptCount":1,"modelAttempts":[{"canonicalSlug":"xai/grok-4.5","success":false,"providerAttemptCount":1,"providerAttempts":[{"provider":"xai","credentialType":"system","success":false,"error":"Service temporarily unavailable","startTime":1784041443272,"endTime":1784041443386,"statusCode":503,"inferenceEndpoint":{"slug":"global","scope":"global"}}]}],"totalProviderAttemptCount":1},"generationId":"gen_01KXGJG3XC3MJ511VVF87ZSBTC"}}}';

describe("provider retry helpers", () => {
  it("marks retryable provider-boundary exceptions", () => {
    const error = createProviderError(
      new Error("Anthropic stream ended before message_stop"),
    );

    expect(error.message).toBe(
      "AI provider error: Anthropic stream ended before message_stop",
    );
    expect(isProviderRetryError(error)).toBe(true);
    expect(isProviderRetryError(createProviderError("invalid_api_key"))).toBe(
      false,
    );
    expect(isProviderRetryError(createProviderError(""))).toBe(false);
    expect(isProviderRetryError(new Error(error.message))).toBe(false);
  });

  it("builds a retry step from resumable Pi history", () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "help" }],
    } as PiMessage;
    const failedAssistant = assistantError(
      "Anthropic stream ended before message_stop",
    );

    expect(
      nextProviderRetry({
        attempt: 0,
        messages: [user, failedAssistant],
        retryableFailure: isRetryableAssistantError(failedAssistant),
      }),
    ).toEqual({ delayMs: 2_000, messages: [user] });
  });

  it("retries a structured xAI 503 despite gateway credential metadata", () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "help" }],
    } as PiMessage;
    const failedAssistant = assistantError(XAI_SERVICE_UNAVAILABLE);

    expect(
      isProviderRetryError(createProviderError(XAI_SERVICE_UNAVAILABLE)),
    ).toBe(true);

    expect(
      nextProviderRetry({
        attempt: 0,
        messages: [user, failedAssistant],
        retryableFailure: isRetryableAssistantError(failedAssistant),
      }),
    ).toEqual({ delayMs: 2_000, messages: [user] });
  });

  it("does not retry explicit credential failures", () => {
    for (const message of [
      "Missing AI gateway credentials (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)",
      '401 {"error":{"message":"The provided credentials are invalid","type":"authentication_error","statusCode":401}}',
      "Provider credentials have expired",
      "Provider credentials were revoked",
    ]) {
      expect(isProviderRetryError(createProviderError(message))).toBe(false);
    }
  });

  it("does not retry permanent, exhausted, or unresumable Pi failures", () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "help" }],
    } as PiMessage;
    const failedAssistant = assistantError("Anthropic overloaded");
    const retry = (
      overrides: {
        attempt?: number;
        messages?: PiMessage[];
        retryableFailure?: boolean;
      } = {},
    ) =>
      nextProviderRetry({
        attempt: 0,
        messages: [user, failedAssistant],
        retryableFailure: true,
        ...overrides,
      });

    for (const message of [
      assistantError("400 bad request"),
      assistantError(undefined),
      fauxAssistantMessage("done"),
      assistantError(
        '429 {"error":{"message":"Quota exceeded","type":"insufficient_quota"}}',
      ),
    ]) {
      expect(isRetryableAssistantError(message)).toBe(false);
    }
    expect(retry({ retryableFailure: false })).toBeUndefined();
    expect(retry({ attempt: 3 })).toBeUndefined();
    expect(retry({ messages: [failedAssistant] })).toBeUndefined();
  });
});
