import { describe, expect, it, vi } from "vitest";
import { getInterruptionMarker } from "@/chat/interruption-marker";
import { createProviderError } from "@/chat/services/provider-error";
import { finalizeFailedTurnReply } from "@/chat/services/turn-failure-response";
import type { AgentRunResult } from "@/chat/services/turn-result";

function providerErrorReply(args: {
  assistantMessageCount: number;
  errorMessage?: string;
  providerError?: unknown;
  text: string;
}): AgentRunResult {
  return {
    text: args.text,
    diagnostics: {
      outcome: "provider_error",
      modelId: "test-model",
      assistantMessageCount: args.assistantMessageCount,
      toolCalls: [],
      toolResultCount: 0,
      toolErrorCount: 0,
      usedPrimaryText: false,
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
      ...(args.providerError ? { providerError: args.providerError } : {}),
    },
  };
}

describe("finalizeFailedTurnReply", () => {
  it("never delivers synthesized error text without assistant messages", () => {
    const logException = vi.fn().mockReturnValue("evt_123");
    const internalError = new Error("ECONNRESET at redis.js:42");

    const finalized = finalizeFailedTurnReply({
      reply: providerErrorReply({
        assistantMessageCount: 0,
        errorMessage: internalError.message,
        providerError: internalError,
        text: "Error: ECONNRESET at redis.js:42",
      }),
      logException,
    });

    expect(finalized.text).not.toContain("ECONNRESET");
    expect(finalized.text).toContain("event_id=evt_123");
  });

  it("records structured provider failure telemetry without raw payloads", () => {
    const logException = vi.fn().mockReturnValue("evt_503");
    const providerError = createProviderError(
      '503 {"error":{"message":"Service temporarily unavailable"}}',
      { modelId: "xai/grok-4.5" },
    );

    finalizeFailedTurnReply({
      reply: providerErrorReply({
        assistantMessageCount: 0,
        errorMessage: providerError.message,
        providerError,
        text: "",
      }),
      logException,
    });

    const attributes = logException.mock.calls[0]?.[2];
    expect(attributes).toMatchObject({
      "app.ai.provider_error.kind": "server",
      "app.ai.provider_error.retryable": true,
      "app.ai.provider_error.status": 503,
      "gen_ai.request.model": "xai/grok-4.5",
    });
    expect(attributes).not.toHaveProperty("exception.message");
  });

  it("records a provider failure preserved inside a domain error", () => {
    const logException = vi.fn().mockReturnValue("evt_guardian");
    const providerError = createProviderError("No object generated", {
      kind: "invalid_response",
      modelId: "openai/gpt-5.6-luna",
    });
    const reviewError = new Error("Action review unavailable", {
      cause: providerError,
    });

    finalizeFailedTurnReply({
      reply: providerErrorReply({
        assistantMessageCount: 0,
        providerError: reviewError,
        text: "",
      }),
      logException,
    });

    expect(logException.mock.calls[0]?.[2]).toMatchObject({
      "app.ai.provider_error.kind": "invalid_response",
      "app.ai.provider_error.retryable": false,
      "gen_ai.request.model": "openai/gpt-5.6-luna",
    });
  });

  it.each([
    {
      error: createProviderError("Blocked by the content policy"),
      explanation: "content policy",
    },
    {
      error: createProviderError("Context length exceeded"),
      explanation: "invalid",
    },
    {
      error: createProviderError(
        "Embedding provider returned invalid vectors",
        {
          kind: "invalid_response",
        },
      ),
      explanation: "invalid response",
    },
  ])(
    "explains terminal provider failures instead of calling them internal errors",
    ({ error, explanation }) => {
      const finalized = finalizeFailedTurnReply({
        reply: providerErrorReply({
          assistantMessageCount: 0,
          errorMessage: error.message,
          providerError: error,
          text: "",
        }),
        logException: vi.fn().mockReturnValue("evt_terminal"),
      });

      expect(finalized.text).toContain(explanation);
      expect(finalized.text).toContain("event_id=evt_terminal");
      expect(finalized.text).not.toContain("internal error");
    },
  );

  it("delivers genuine model-authored partial text with the interruption marker", () => {
    const logException = vi.fn().mockReturnValue("evt_456");

    const finalized = finalizeFailedTurnReply({
      reply: providerErrorReply({
        assistantMessageCount: 1,
        text: "Here is what I found so far",
      }),
      logException,
    });

    expect(finalized.text).toBe(
      `Here is what I found so far${getInterruptionMarker()}`,
    );
  });
});
