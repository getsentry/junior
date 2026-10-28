import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { decideReply } from "@/chat/services/assistant-reply";

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

describe("assistant reply", () => {
  it("returns visible text without thinking content", () => {
    expect(
      decideReply(
        assistant("<thinking>private reasoning</thinking>Visible answer."),
      ),
    ).toEqual({ kind: "deliver", text: "Visible answer." });
  });

  it("suppresses trailing no-reply text and tool-call messages", () => {
    expect(decideReply(assistant(NO_REPLY_MARKER))).toEqual({
      kind: "suppress",
    });
    expect(
      decideReply(assistant(`staying silent.\n${NO_REPLY_MARKER}`)),
    ).toEqual({ kind: "suppress" });
    expect(decideReply(assistant(`Done. ${NO_REPLY_MARKER}`))).toEqual({
      kind: "suppress",
    });
    const mention = `Earlier turn used ${NO_REPLY_MARKER} and then stopped.`;
    expect(decideReply(assistant(mention))).toEqual({
      kind: "deliver",
      text: mention,
    });
    expect(decideReply(assistant("Let me do that now.", true))).toEqual({
      kind: "suppress",
    });
  });

  it("delivers nonempty tool-free text without interpreting it", () => {
    const text = `\`\`\`json
{"type":"tool_call","name":"example","input":{}}
\`\`\`

Should I proceed with the real call?`;
    expect(decideReply(assistant(text))).toEqual({
      kind: "deliver",
      text,
    });
  });
});
