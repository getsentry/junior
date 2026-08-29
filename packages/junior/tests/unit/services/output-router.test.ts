import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import {
  applyAssistantOutputText,
  decideOutputRouteDeterministic,
  OUTPUT_REPLY_HARD_MAX_CHARS,
  routeAssistantMessage,
  routeAssistantOutput,
} from "@/chat/services/output-router";

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
}));

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

describe("output router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("suppresses exact no-reply markers without a model call", async () => {
    const completeObject = vi.fn();
    await expect(
      routeAssistantOutput({
        completeObject,
        fastModelId: "openai/gpt-5.6-luna",
        text: NO_REPLY_MARKER,
      }),
    ).resolves.toEqual({
      action: "suppress",
      reason: "no_reply_marker",
      source: "deterministic",
    });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("strips mixed no-reply markers deterministically", () => {
    expect(
      decideOutputRouteDeterministic(
        `shipped it ${NO_REPLY_MARKER}\nmore detail`,
      ),
    ).toEqual({
      action: "deliver",
      text: "shipped it\nmore detail",
      reason: "stripped_mixed_no_reply_marker",
      source: "deterministic",
    });
  });

  it("routes long answers through the fast model", async () => {
    const completeObject = vi.fn(async () => ({
      costUsd: 0.0004,
      object: {
        action: "rewrite",
        text: "Short answer with the outcome.",
        reason: "too long",
      },
    }));

    const route = await routeAssistantOutput({
      completeObject,
      fastModelId: "openai/gpt-5.6-luna",
      text: "A".repeat(900),
    });

    expect(route).toEqual({
      action: "deliver",
      text: "Short answer with the outcome.",
      reason: "too long",
      source: "router",
      costUsd: 0.0004,
    });
    expect(completeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "openai/gpt-5.6-luna",
        promptName: "junior.output_route",
        temperature: 0,
        thinkingLevel: "low",
        system: expect.stringContaining("final output router"),
      }),
    );
  });

  it("fails open to the original text when the classifier errors", async () => {
    const completeObject = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      routeAssistantOutput({
        completeObject,
        fastModelId: "openai/gpt-5.6-luna",
        text: "Keep this answer.",
      }),
    ).resolves.toEqual({
      action: "deliver",
      text: "Keep this answer.",
      reason: "classifier_error_passthrough",
      source: "fallback",
    });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "ai.output_router.failed",
      expect.objectContaining({ "exception.message": "boom" }),
    );
  });

  it("hard-caps oversized routed text", async () => {
    const completeObject = vi.fn(async () => ({
      object: {
        action: "rewrite",
        text: "B".repeat(OUTPUT_REPLY_HARD_MAX_CHARS + 50),
        reason: "still long",
      },
    }));

    const route = await routeAssistantOutput({
      completeObject,
      fastModelId: "openai/gpt-5.6-luna",
      text: "A".repeat(900),
    });

    expect(route.action).toBe("deliver");
    expect(route.text?.length).toBe(OUTPUT_REPLY_HARD_MAX_CHARS);
    expect(route.text?.endsWith("…")).toBe(true);
  });

  it("rewrites the assistant message in place before delivery", async () => {
    const message = assistant("A".repeat(900));
    const completeObject = vi.fn(async () => ({
      object: {
        action: "rewrite",
        text: "Condensed reply.",
        reason: "too long",
      },
    }));

    const routed = await routeAssistantMessage({
      completeObject,
      fastModelId: "openai/gpt-5.6-luna",
      message,
    });

    expect(routed).toMatchObject({
      kind: "deliver",
      route: { action: "deliver", text: "Condensed reply." },
    });
    expect(message.content).toEqual([{ type: "text", text: "Condensed reply." }]);
  });

  it("skips tool-bearing assistant messages", async () => {
    const completeObject = vi.fn();
    await expect(
      routeAssistantMessage({
        completeObject,
        fastModelId: "openai/gpt-5.6-luna",
        message: assistant("working", true),
      }),
    ).resolves.toEqual({ kind: "skip" });
    expect(completeObject).not.toHaveBeenCalled();
  });

  it("applies rewritten text while preserving non-text parts", () => {
    const message = assistant("old");
    message.content.push({
      type: "toolCall",
      id: "call-2",
      name: "bash",
      arguments: {},
    });
    applyAssistantOutputText(message, "new");
    expect(message.content).toEqual([
      { type: "text", text: "new" },
      {
        type: "toolCall",
        id: "call-2",
        name: "bash",
        arguments: {},
      },
    ]);
  });
});
