import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import {
  OUTPUT_REPLY_HARD_MAX_CHARS,
  prepareAssistantMessage,
  prepareAssistantReply,
  prepareAssistantReplyLocal,
} from "@/chat/services/output-router";

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

describe("prepare assistant reply", () => {
  it("handles empty, exact, and trailing silence markers locally", () => {
    expect(prepareAssistantReplyLocal("")).toEqual({
      kind: "silent",
      reason: "empty",
    });
    expect(prepareAssistantReplyLocal(NO_REPLY_MARKER)).toEqual({
      kind: "silent",
      reason: "no_reply",
    });
    // A final whole-line marker suppresses the whole message.
    expect(
      prepareAssistantReplyLocal(
        [`status only note`, "", NO_REPLY_MARKER].join("\n"),
      ),
    ).toEqual({
      kind: "silent",
      reason: "trailing_no_reply",
    });
    // Inline marker mentions still need the model.
    expect(
      prepareAssistantReplyLocal(`shipped it ${NO_REPLY_MARKER}\nmore detail`),
    ).toBeNull();
  });

  it("skips the model for exact silence markers", async () => {
    const completeObject = vi.fn();
    await expect(
      prepareAssistantReply({
        completeObject,
        fastModelId: "openai/gpt-5.6-luna",
        text: NO_REPLY_MARKER,
      }),
    ).resolves.toEqual({
      kind: "silent",
      reason: "no_reply",
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("keeps the original text when the model call fails", async () => {
    const completeObject = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      prepareAssistantReply({
        completeObject,
        fastModelId: "openai/gpt-5.6-luna",
        text: "Keep this answer.",
      }),
    ).resolves.toEqual({
      kind: "reply",
      text: "Keep this answer.",
      reason: "prepare_failed",
    });
  });

  it("caps oversized model text", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        text: "B".repeat(OUTPUT_REPLY_HARD_MAX_CHARS + 50),
        reason: "still long",
      },
    }));

    const prepared = await prepareAssistantReply({
      completeObject,
      fastModelId: "openai/gpt-5.6-luna",
      text: "A".repeat(900),
    });

    expect(prepared.kind).toBe("reply");
    if (prepared.kind !== "reply") return;
    expect(prepared.text.length).toBe(OUTPUT_REPLY_HARD_MAX_CHARS);
    expect(prepared.text.endsWith("…")).toBe(true);
  });

  it("returns visible text without changing the agent message", async () => {
    const original = "A".repeat(900);
    const message = assistant(original);
    const completeObject = vi.fn(async () => ({
      object: {
        text: "Condensed reply.",
        reason: "too long",
      },
    }));

    const prepared = await prepareAssistantMessage({
      completeObject,
      fastModelId: "openai/gpt-5.6-luna",
      message,
    });

    expect(prepared).toMatchObject({
      kind: "reply",
      text: "Condensed reply.",
    });
    expect(message.content).toEqual([{ type: "text", text: original }]);
  });

  it("skips tool-bearing assistant messages", async () => {
    const completeObject = vi.fn();
    await expect(
      prepareAssistantMessage({
        completeObject,
        fastModelId: "openai/gpt-5.6-luna",
        message: assistant("working", true),
      }),
    ).resolves.toEqual({ kind: "skip" });
    expect(completeObject).not.toHaveBeenCalled();
  });
});
