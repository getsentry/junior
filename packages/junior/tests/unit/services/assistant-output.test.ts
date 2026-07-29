import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { classifyAssistantOutput } from "@/chat/services/assistant-output";

function assistant(text: string, withToolCall = false): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      ...(withToolCall
        ? [
            {
              type: "toolCall" as const,
              id: "call-1",
              name: "bash",
              arguments: {},
            },
          ]
        : []),
    ],
    api: "responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("assistant output", () => {
  it("returns visible text without thinking content", () => {
    expect(
      classifyAssistantOutput(
        assistant("<thinking>private reasoning</thinking>Visible answer."),
      ),
    ).toEqual({ kind: "deliver", text: "Visible answer." });
  });

  it("suppresses protocol and execution-only output", () => {
    expect(classifyAssistantOutput(assistant(NO_REPLY_MARKER))).toEqual({
      kind: "suppress",
    });
    expect(
      classifyAssistantOutput(
        assistant(
          JSON.stringify({
            type: "tool_call",
            name: "addReaction",
            input: { emoji: "eyes" },
          }),
        ),
      ),
    ).toEqual({ kind: "reject", reason: "raw_tool_payload" });
    expect(
      classifyAssistantOutput(
        assistant("Let me do that now. Give me a moment."),
      ),
    ).toEqual({ kind: "reject", reason: "execution_escape" });
    expect(
      classifyAssistantOutput(assistant("Let me do that now.", true)),
    ).toEqual({ kind: "suppress" });
  });

  it("only rejects opaque tool fragments in compacted context", () => {
    expect(classifyAssistantOutput(assistant("Repos6azabash"))).toEqual({
      kind: "deliver",
      text: "Repos6azabash",
    });
    expect(classifyAssistantOutput(assistant("Repos6azabash"), true)).toEqual({
      kind: "reject",
      reason: "opaque_tool_fragment",
    });
    expect(classifyAssistantOutput(assistant("repo123"), true)).toEqual({
      kind: "deliver",
      text: "repo123",
    });
  });

  it("keeps prose that quotes a tool payload fragment", () => {
    const text = 'The field `"type": "tool_call"` identifies a tool call.';
    expect(classifyAssistantOutput(assistant(text))).toEqual({
      kind: "deliver",
      text,
    });
  });
});
