import { describe, expect, it } from "vitest";
import { keepRuntimeContextOutsidePromptCache } from "@/chat/pi/prompt-cache-boundary";

const model = {
  api: "anthropic-messages",
} as Parameters<typeof keepRuntimeContextOutsidePromptCache>[1];

function text(text: string, cached = false) {
  const block: {
    cache_control?: { type: string };
    text: string;
    type: string;
  } = { type: "text", text };
  if (cached) {
    block.cache_control = { type: "ephemeral" };
  }
  return block;
}

describe("prompt cache boundary", () => {
  it("moves the trailing cache marker before volatile runtime context", () => {
    const payload = {
      messages: [
        { role: "user", content: [text("earlier request")] },
        { role: "assistant", content: [text("earlier reply")] },
        {
          role: "user",
          content: [text("<runtime-turn-context>volatile</runtime-turn-context>")],
        },
        { role: "user", content: [text("current request", true)] },
      ],
    };

    expect(keepRuntimeContextOutsidePromptCache(payload, model)).toBe(payload);
    expect(payload.messages[3]!.content[0]).not.toHaveProperty("cache_control");
    expect(payload.messages[1]!.content[0]).toHaveProperty("cache_control", {
      type: "ephemeral",
    });
  });

  it("does not cache volatile context when no durable history exists", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [text("<runtime-turn-context>volatile</runtime-turn-context>")],
        },
        { role: "user", content: [text("current request", true)] },
      ],
    };

    expect(keepRuntimeContextOutsidePromptCache(payload, model)).toBe(payload);
    expect(payload.messages[1]!.content[0]).not.toHaveProperty("cache_control");
    expect(payload.messages[0]!.content[0]).not.toHaveProperty("cache_control");
  });

  it("leaves later in-turn calls unchanged", () => {
    const payload = {
      messages: [
        { role: "user", content: [text("request")] },
        { role: "assistant", content: [text("tool call")] },
        { role: "user", content: [text("tool result", true)] },
      ],
    };

    expect(keepRuntimeContextOutsidePromptCache(payload, model)).toBeUndefined();
    expect(payload.messages[2]!.content[0]).toHaveProperty("cache_control");
  });
});
