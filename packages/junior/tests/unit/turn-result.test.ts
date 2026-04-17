import { beforeEach, describe, expect, it, vi } from "vitest";
const { logWarn } = vi.hoisted(() => ({
  logWarn: vi.fn(),
}));

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
  logWarn,
}));

import { buildTurnResult } from "@/chat/services/turn-result";

describe("buildTurnResult", () => {
  beforeEach(() => {
    logWarn.mockClear();
  });

  it("treats empty tool-only turns as execution failures", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "bash",
          isError: false,
          stdout: "ok",
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I don't have access to active tool.",
            },
          ],
          stopReason: "stop",
        },
      ],
      userInput: "Open the GitHub issue",
      replyFiles: [],
      artifactStatePatch: {},
      toolCalls: [],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
    });

    expect(reply.text).toBe(
      "I couldn't complete this request in this turn due to an execution failure. I've logged the details for debugging.",
    );
    expect(reply.diagnostics.outcome).toBe("execution_failure");
  });

  it("ignores provisional assistant text that appears before the last tool result", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Let me go check the latest articles and compare them.",
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "webSearch",
          isError: false,
          content: [{ type: "text", text: "search results" }],
        },
      ],
      userInput: "Pull the latest blog post and compare related articles",
      replyFiles: [],
      artifactStatePatch: {},
      toolCalls: ["webSearch"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
    });

    expect(reply.text).toBe(
      "I couldn't complete this request in this turn due to an execution failure. I've logged the details for debugging.",
    );
    expect(reply.diagnostics.outcome).toBe("execution_failure");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("uses only terminal assistant text after tool results", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Let me check that." }],
        },
        {
          role: "toolResult",
          toolName: "webSearch",
          isError: false,
          content: [{ type: "text", text: "search results" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is the actual summary." }],
          stopReason: "stop",
        },
      ],
      userInput: "Pull the latest blog post and compare related articles",
      replyFiles: [],
      artifactStatePatch: {},
      toolCalls: ["webSearch"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
    });

    expect(reply.text).toBe("Here is the actual summary.");
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("treats reaction-only turns as successful without fallback text", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "slackMessageAddReaction",
          isError: false,
          content: [{ type: "text", text: "reaction added" }],
        },
      ],
      userInput: "react to this",
      replyFiles: [],
      artifactStatePatch: {},
      toolCalls: ["slackMessageAddReaction"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: false,
    });
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("preserves structured timing and usage diagnostics", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stopReason: "stop",
        },
      ],
      userInput: "Do the thing",
      replyFiles: [],
      artifactStatePatch: {},
      toolCalls: [],
      durationMs: 1532,
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      usage: {
        inputTokens: 321,
        outputTokens: 144,
        totalTokens: 465,
      },
    });

    expect(reply.diagnostics.durationMs).toBe(1532);
    expect(reply.diagnostics.usage).toEqual({
      inputTokens: 321,
      outputTokens: 144,
      totalTokens: 465,
    });
  });
});
