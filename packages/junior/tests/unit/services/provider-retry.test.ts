import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiMessage } from "@/chat/pi/messages";
import {
  nextProviderRetry,
  createProviderError,
  isProviderRetryError,
} from "@/chat/services/provider-retry";

function assistantError(
  errorMessage: string | undefined,
): Pick<AssistantMessage, "stopReason" | "errorMessage"> {
  return {
    stopReason: "error",
    errorMessage,
  };
}

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
    const failedAssistant = {
      role: "assistant",
      content: [],
      stopReason: "error",
    } as unknown as PiMessage;

    expect(
      nextProviderRetry({
        attempt: 0,
        lastAssistant: assistantError(
          "Anthropic stream ended before message_stop",
        ),
        messages: [user, failedAssistant],
      }),
    ).toEqual({ delayMs: 2_000, messages: [user] });
  });

  it("does not retry permanent, exhausted, or unresumable Pi failures", () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "help" }],
    } as PiMessage;
    const failedAssistant = {
      role: "assistant",
      content: [],
      stopReason: "error",
    } as unknown as PiMessage;
    const retry = (
      overrides: {
        attempt?: number;
        lastAssistant?: Pick<AssistantMessage, "stopReason" | "errorMessage">;
        messages?: PiMessage[];
      } = {},
    ) =>
      nextProviderRetry({
        attempt: 0,
        lastAssistant: assistantError("Anthropic overloaded"),
        messages: [user, failedAssistant],
        ...overrides,
      });

    expect(
      retry({
        lastAssistant: assistantError("400 bad request"),
      }),
    ).toBeUndefined();
    expect(
      retry({
        lastAssistant: assistantError(undefined),
      }),
    ).toBeUndefined();
    expect(retry({ lastAssistant: { stopReason: "stop" } })).toBeUndefined();
    expect(retry({ attempt: 3 })).toBeUndefined();
    expect(retry({ messages: [failedAssistant] })).toBeUndefined();
  });
});
