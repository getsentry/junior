import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiMessage } from "@/chat/pi/messages";
import {
  isRetryableProviderError,
  trimRetryableProviderErrorTail,
} from "@/chat/services/provider-retry";

function assistantError(
  errorMessage: string,
): Pick<AssistantMessage, "stopReason" | "errorMessage"> {
  return {
    stopReason: "error",
    errorMessage,
  };
}

describe("provider retry helpers", () => {
  it("matches transient provider stream failures", () => {
    expect(
      isRetryableProviderError(
        assistantError("Anthropic stream ended before message_stop"),
      ),
    ).toBe(true);
    expect(
      isRetryableProviderError(
        assistantError("Provider finish_reason: network_error"),
      ),
    ).toBe(true);
    expect(isRetryableProviderError(assistantError("overloaded_error"))).toBe(
      true,
    );
  });

  it("does not match auth or validation failures", () => {
    expect(isRetryableProviderError(assistantError("invalid_api_key"))).toBe(
      false,
    );
    expect(isRetryableProviderError(assistantError("400 bad request"))).toBe(
      false,
    );
    expect(isRetryableProviderError({ stopReason: "stop" })).toBe(false);
  });

  it("trims a failed assistant tail only at a continuable boundary", () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "help" }],
    } as PiMessage;
    const toolResult = {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
    } as PiMessage;
    const failedAssistant = {
      role: "assistant",
      content: [],
      stopReason: "error",
    } as unknown as PiMessage;

    expect(
      trimRetryableProviderErrorTail([user, toolResult, failedAssistant]),
    ).toEqual([user, toolResult]);
    expect(trimRetryableProviderErrorTail([failedAssistant])).toBeUndefined();
  });
});
