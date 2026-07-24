import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { PiMessage } from "@/chat/pi/messages";
import {
  createProviderError,
  getProviderErrorUserMessage,
  isProviderRetryError,
  ProviderError,
} from "@/chat/services/provider-error";
import { nextProviderRetry } from "@/chat/services/provider-retry";

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
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      code: "provider_error",
      kind: "network",
      retryable: true,
    });
    expect(isProviderRetryError(error)).toBe(true);
    expect(isProviderRetryError(createProviderError("invalid_api_key"))).toBe(
      false,
    );
    expect(isProviderRetryError(createProviderError(""))).toBe(false);
    expect(isProviderRetryError(new Error(error.message))).toBe(false);
  });

  it("retries transport errno failures from direct and nested causes", () => {
    for (const code of [
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "EAI_AGAIN",
    ]) {
      const error = Object.assign(new Error("Provider request failed"), {
        code,
      });
      expect(createProviderError(error)).toMatchObject({
        kind: "network",
        retryable: true,
      });
    }

    for (const code of ["ETIMEDOUT", "ECONNABORTED", "ESOCKETTIMEDOUT"]) {
      const error = new Error("Provider request failed", {
        cause: Object.assign(new Error("Transport failed"), { code }),
      });
      expect(createProviderError(error)).toMatchObject({
        kind: "timeout",
        retryable: true,
      });
    }
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
        failure: failedAssistant,
        messages: [user, failedAssistant],
      }),
    ).toEqual({ delayMs: 2_000, messages: [user] });
  });

  it("retries a structured xAI 503 despite gateway credential metadata", () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "help" }],
    } as PiMessage;
    const failedAssistant = assistantError(XAI_SERVICE_UNAVAILABLE);

    const providerError = createProviderError(XAI_SERVICE_UNAVAILABLE);
    expect(providerError).toMatchObject({
      kind: "server",
      modelId: "xai/grok-4.5",
      retryable: true,
      status: 503,
    });
    expect(isProviderRetryError(providerError)).toBe(true);

    expect(
      nextProviderRetry({
        attempt: 0,
        failure: failedAssistant,
        messages: [user, failedAssistant],
      }),
    ).toEqual({ delayMs: 2_000, messages: [user] });
  });

  it("honors bounded rate-limit hints", () => {
    const error = Object.assign(new Error("rate limited"), {
      responseHeaders: { "Retry-After": "30" },
      statusCode: 429,
    });
    expect(createProviderError(error)).toMatchObject({
      kind: "rate_limit",
      retryable: true,
      retryAfterMs: 30_000,
      status: 429,
    });

    const user = {
      role: "user",
      content: [{ type: "text", text: "help" }],
    } as PiMessage;
    const failedAssistant = assistantError(
      '429 too many requests {"retry-after":"90"}',
    );
    expect(
      nextProviderRetry({
        attempt: 0,
        failure: failedAssistant,
        messages: [user, failedAssistant],
      }),
    ).toEqual({ delayMs: 60_000, messages: [user] });
  });

  it("retries common server failures without treating bare safety text as policy", () => {
    for (const message of [
      "Internal Server Error",
      "Error: 502 Bad Gateway",
      "upstream request failed",
      "An unexpected error occurred",
      "503 Safety service temporarily unavailable",
    ]) {
      expect(createProviderError(message)).toMatchObject({
        retryable: true,
      });
    }

    expect(createProviderError("Blocked by the safety policy")).toMatchObject({
      kind: "content_policy",
      retryable: false,
    });
  });

  it("preserves Pi transient provider retry signals", () => {
    for (const message of [
      "ResourceExhausted",
      "Provider returned error",
      "Internal error",
      "other side closed",
      "upstream connect error",
      "reset before headers",
      "stream ended without a final event",
      "HTTP2 request did not get a response",
      "retry delay exceeded",
      "you can retry your request",
      "try your request again",
      "please retry your request",
    ]) {
      expect(isProviderRetryError(createProviderError(message))).toBe(true);
    }
  });

  it("does not claim a retry happened in terminal capacity copy", () => {
    const message = getProviderErrorUserMessage(
      createProviderError("Provider capacity exceeded"),
    );

    expect(message).toContain("at capacity");
    expect(message).not.toContain("retried");
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
        failure?: AssistantMessage;
      } = {},
    ) =>
      nextProviderRetry({
        attempt: 0,
        failure: failedAssistant,
        messages: [user, failedAssistant],
        ...overrides,
      });

    for (const failure of [
      assistantError("400 bad request"),
      assistantError(undefined),
      fauxAssistantMessage("done"),
      assistantError(
        '429 {"error":{"message":"Quota exceeded","type":"insufficient_quota"}}',
      ),
    ]) {
      expect(retry({ failure })).toBeUndefined();
    }
    expect(retry({ attempt: 3 })).toBeUndefined();
    expect(
      retry({ failure: undefined, messages: [failedAssistant] }),
    ).toBeUndefined();
  });
});
