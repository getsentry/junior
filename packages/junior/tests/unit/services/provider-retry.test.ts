import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { PiMessage } from "@/chat/pi/messages";
import {
  createProviderError,
  findProviderError,
  getProviderErrorUserMessage,
  isProviderRetryError,
  ProviderError,
} from "@/chat/services/provider-error";
import { nextProviderRetry } from "@/chat/services/provider-retry";

function assistantError(errorMessage: string | undefined): AssistantMessage {
  return fauxAssistantMessage([], {
    stopReason: "error",
    ...(errorMessage ? { errorMessage } : undefined),
  });
}

const XAI_SERVICE_UNAVAILABLE =
  '503 {"error":{"message":"Service temporarily unavailable","statusCode":503},"providerMetadata":{"gateway":{"routing":{"originalModelId":"xai/grok-4.5","providerAttempts":[{"credentialType":"system"}]}}}}';

describe("provider retry helpers", () => {
  it("marks retryable provider-boundary exceptions", () => {
    const cause = new Error("Anthropic stream ended before message_stop");
    const error = createProviderError(cause);

    expect(error.message).toBe("AI provider error: network");
    expect(error.cause).toBe(cause);
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

  it("finds provider errors preserved by domain wrappers", () => {
    const providerError = createProviderError("No object generated", {
      kind: "invalid_response",
      modelId: "openai/gpt-5.6-luna",
    });
    const wrapped = new Error("Action review unavailable", {
      cause: providerError,
    });

    expect(findProviderError(wrapped)).toBe(providerError);
    expect(findProviderError(new Error("unrelated"))).toBeUndefined();
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

  it("uses structured transient signals when the provider message is empty", () => {
    for (const [statusCode, kind] of [
      [503, "server"],
      [429, "rate_limit"],
      [408, "timeout"],
    ] as const) {
      expect(
        createProviderError(Object.assign(new Error(""), { statusCode })),
      ).toMatchObject({
        kind,
        retryable: true,
        status: statusCode,
      });
    }

    expect(
      createProviderError(Object.assign(new Error(""), { code: "ECONNRESET" })),
    ).toMatchObject({
      kind: "network",
      retryable: true,
    });
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

    const providerError = createProviderError(XAI_SERVICE_UNAVAILABLE, {
      modelId: "xai/grok-4.5",
    });
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

  it("classifies HTTP request timeouts without overriding permanent signals", () => {
    expect(
      createProviderError(
        Object.assign(new Error("Request failed"), { statusCode: 408 }),
      ),
    ).toMatchObject({
      kind: "timeout",
      retryable: true,
      status: 408,
    });

    for (const message of ["Invalid model", "Context length exceeded"]) {
      expect(
        createProviderError(
          Object.assign(new Error(message), { statusCode: 408 }),
        ),
      ).toMatchObject({
        kind: "invalid_request",
        retryable: false,
        status: 408,
      });
    }
  });

  it("retries common server failures without treating bare safety text as policy", () => {
    for (const message of [
      "Error: 502 Bad Gateway",
      "503 Safety service temporarily unavailable",
      "Authorization service internal error",
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

  it("uses Pi's transient provider retry decision", () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "help" }],
    } as PiMessage;
    const failure = assistantError("ResourceExhausted");

    expect(
      nextProviderRetry({
        attempt: 0,
        failure,
        messages: [user, failure],
      }),
    ).toEqual({ delayMs: 2_000, messages: [user] });
  });

  it("keeps explicit permanent request failures terminal", () => {
    for (const error of [
      Object.assign(new Error("Invalid model"), { statusCode: 503 }),
      "500 Bad Request",
    ]) {
      expect(createProviderError(error)).toMatchObject({
        kind: "invalid_request",
        retryable: false,
      });
    }
  });

  it("does not claim a retry happened in terminal capacity copy", () => {
    const message = getProviderErrorUserMessage(
      createProviderError("Provider capacity exceeded"),
    );

    expect(message).toContain("at capacity");
    expect(message).not.toContain("retried");
  });

  it("does not blame credentials for provider access failures", () => {
    const message = getProviderErrorUserMessage(
      createProviderError(
        Object.assign(new Error("Forbidden"), { statusCode: 403 }),
      ),
    );

    expect(message).toContain("denied access");
    expect(message).not.toContain("credentials");
  });

  it("does not retry explicit credential failures", () => {
    expect(
      createProviderError("Unauthenticated request to AI Gateway"),
    ).toMatchObject({
      kind: "auth",
      retryable: false,
    });

    for (const message of [
      "Missing AI gateway credentials (enable Vercel OIDC or set AI_GATEWAY_API_KEY)",
      '401 {"error":{"message":"The provided credentials are invalid","type":"authentication_error","statusCode":401}}',
      "Permission denied",
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
      assistantError("503 invalid model"),
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
