import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { assistantReplyText } from "@/core/turn/replies";

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
    api: "anthropic-messages",
    provider: "anthropic",
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

describe("assistantReplyText", () => {
  it("is no reply when the message calls a tool", () => {
    expect(
      assistantReplyText(assistant("Let me check.", true)),
    ).toBeUndefined();
  });

  it("removes leaked thinking outside fenced code", () => {
    expect(
      assistantReplyText(
        assistant("<thinking>private</thinking>Visible answer."),
      ),
    ).toBe("Visible answer.");
  });

  it("keeps thinking tags inside a closed fence, also in a list or quote", () => {
    const list = [
      "<thinking>private</thinking>Use the tag:",
      "",
      "1. Wrap it:",
      "   ~~~xml",
      "   <thinking>example tag</thinking>",
      "   ~~~",
    ].join("\n");
    expect(assistantReplyText(assistant(list))).toBe(
      list.replace("<thinking>private</thinking>", ""),
    );
    const quote = "> ```\n> <thinking>example</thinking>\n> ```";
    expect(assistantReplyText(assistant(quote))).toBe(quote);
  });

  it("removes thinking after a fence with no closing line", () => {
    expect(
      assistantReplyText(
        assistant("Run this:\n```sh\npnpm test\n<thinking>private</thinking>"),
      ),
    ).toBe("Run this:\n```sh\npnpm test");
  });

  it("is no reply for empty text or a whole legacy marker", () => {
    expect(assistantReplyText(assistant("  \n"))).toBeUndefined();
    expect(assistantReplyText(assistant(" [[QUIET]]\n"))).toBeUndefined();
    expect(assistantReplyText(assistant("Done. [[NO_REPLY]]"))).toBe(
      "Done. [[NO_REPLY]]",
    );
  });
});
