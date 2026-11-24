import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { classifyFailure, retryAfterMs } from "@/core/model/failure";

function failedReply(fields: {
  errorMessage?: string;
  rawStopReason?: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    model: "anthropic/claude-sonnet-4.6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: 0,
    ...fields,
  };
}

describe("classifyFailure", () => {
  it.each([
    [401, undefined, "auth", false],
    [402, undefined, "quota", false],
    [403, undefined, "permission", false],
    [404, "not_found_error", "invalid_request", false],
    [429, undefined, "rate_limit", true],
    [500, "api_error", "server", true],
    [503, undefined, "server", true],
    [504, undefined, "timeout", true],
    [529, "overloaded_error", "capacity", true],
    [400, "invalid_request_error", "invalid_request", false],
  ] as const)(
    "classifies status %i with error type %s as %s",
    (status, errorType, kind, retryable) => {
      const failure = classifyFailure(
        { errorResponse: { status, errorType } },
        failedReply({ errorMessage: `${status} {"error":{}}` }),
      );
      expect(failure).toMatchObject({ kind, retryable, status });
    },
  );

  it("prefers the provider's error type to the status", () => {
    const failure = classifyFailure(
      { errorResponse: { status: 500, errorType: "overloaded_error" } },
      failedReply({}),
    );
    expect(failure).toMatchObject({
      kind: "capacity",
      providerType: "overloaded_error",
    });
  });

  it("keeps the wait and the provider's message of an error response", () => {
    const failure = classifyFailure(
      {
        errorResponse: {
          status: 429,
          retryAfterMs: 2000,
          errorMessage: "Rate limit exceeded",
        },
      },
      failedReply({ errorMessage: '429 {"error":{"message":"..."}}' }),
    );
    expect(failure).toEqual({
      kind: "rate_limit",
      retryable: true,
      status: 429,
      retryAfterMs: 2000,
      message: "Rate limit exceeded",
    });
  });

  it("reads the error type of a stream error event", () => {
    const failure = classifyFailure(
      {},
      failedReply({
        errorMessage:
          '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      }),
    );
    expect(failure).toMatchObject({
      kind: "capacity",
      retryable: true,
      providerType: "overloaded_error",
      message: "Overloaded",
    });
  });

  it.each([
    ["TypeError", "network"],
    ["TimeoutError", "timeout"],
  ] as const)("classifies a %s on the connection as %s", (name, kind) => {
    expect(
      classifyFailure({ transportError: name }, failedReply({})),
    ).toMatchObject({ kind, retryable: true });
  });

  it("classifies a refusal as a content policy failure", () => {
    expect(
      classifyFailure({}, failedReply({ rawStopReason: "refusal" })),
    ).toMatchObject({ kind: "content_policy", retryable: false });
  });

  it("does not guess a kind from the words of the error text", () => {
    expect(
      classifyFailure({}, failedReply({ errorMessage: "rate limit exceeded" })),
    ).toMatchObject({ kind: "unknown", retryable: false });
  });
});

describe("retryAfterMs", () => {
  it("reads retry-after-ms, then retry-after seconds", () => {
    expect(retryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000);
    expect(retryAfterMs(new Headers())).toBeUndefined();
  });
});
