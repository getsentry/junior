import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { getDiscardedRetryUsage } from "@/chat/agent/retry-usage";

function assistant(
  text: string,
  usage: { input: number; output: number },
): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "responses",
    provider: "openai",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: 1,
  } as PiMessage;
}

describe("retry usage", () => {
  it("counts only assistant messages discarded by the retry", () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "Continue." }],
      timestamp: 1,
    } as PiMessage;
    const toolCall = assistant("Calling the tool.", { input: 4, output: 1 });
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 2,
    } as PiMessage;
    const emptyOutput = assistant("", { input: 10, output: 2 });
    const messages = [user, toolCall, toolResult, emptyOutput];

    expect(getDiscardedRetryUsage(messages, messages.slice(0, -1))).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
  });

  it("rejects retry histories that rewrite retained messages", () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "Continue." }],
      timestamp: 1,
    } as PiMessage;

    expect(() =>
      getDiscardedRetryUsage([message], [{ ...message } as PiMessage]),
    ).toThrow("Agent retry must retain an exact message prefix");
  });
});
