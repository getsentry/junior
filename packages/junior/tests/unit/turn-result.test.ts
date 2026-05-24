import { describe, expect, it } from "vitest";

import { buildTurnResult } from "@/chat/services/turn-result";

const thinkingSelection = {
  thinkingLevel: "medium" as const,
  reason: "test",
};

describe("buildTurnResult", () => {
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
      thinkingSelection,
    });

    expect(reply.text).toBe("");
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
      thinkingSelection,
    });

    expect(reply.text).toBe("");
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
      thinkingSelection,
    });

    expect(reply.text).toBe("Here is the actual summary.");
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("treats terminal provider errors without text as provider errors", () => {
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
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic stream ended before message_stop",
        },
      ],
      userInput: "Do the thing",
      replyFiles: [],
      artifactStatePatch: {},
      toolCalls: ["bash"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      thinkingSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.diagnostics.outcome).toBe("provider_error");
    expect(reply.diagnostics.errorMessage).toBe(
      "Anthropic stream ended before message_stop",
    );
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
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
      thinkingSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: false,
    });
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("suppresses empty thread text when a channel post is the successful side effect", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "slackChannelPostMessage",
          isError: false,
          content: [{ type: "text", text: "message posted" }],
        },
      ],
      userInput: "share the update",
      replyFiles: [],
      artifactStatePatch: {},
      toolCalls: ["slackChannelPostMessage"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      thinkingSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      mode: "thread",
      postThreadText: false,
    });
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("keeps thread text when a turn adds a reaction and returns real text", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "slackMessageAddReaction",
          isError: false,
          content: [{ type: "text", text: "reaction added" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Handled it." }],
          stopReason: "stop",
        },
      ],
      userInput: "react and confirm",
      replyFiles: [],
      artifactStatePatch: {},
      toolCalls: ["slackMessageAddReaction"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      thinkingSelection,
    });

    expect(reply.text).toBe("Handled it.");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: true,
    });
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("suppresses model text for reaction-only requests", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "slackMessageAddReaction",
          isError: false,
          content: [{ type: "text", text: "reaction added" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "արձագանքեցի :thumbsup:" }],
          stopReason: "stop",
        },
      ],
      userInput: "react to this",
      replyFiles: [],
      artifactStatePatch: {},
      toolCalls: ["slackMessageAddReaction"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      thinkingSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: false,
    });
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("keeps thread delivery enabled for reaction turns that fail validation", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "slackMessageAddReaction",
          isError: false,
          content: [{ type: "text", text: "reaction added" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                type: "tool_call",
                name: "slackMessageAddReaction",
                input: { reaction: "thumbsup" },
              }),
            },
          ],
          stopReason: "stop",
        },
      ],
      userInput: "react and tell me what happened",
      replyFiles: [],
      artifactStatePatch: {},
      toolCalls: ["slackMessageAddReaction"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      thinkingSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: true,
    });
    expect(reply.diagnostics.outcome).toBe("execution_failure");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("keeps post-canvas thread replies brief", () => {
    const verboseReply = [
      "I put together a reusable reference here:",
      "https://example.invalid/files/F123",
      "",
      "**Highlights**",
      "- Timeline details that belong in the canvas.",
      "- API details that belong in the canvas.",
      "- Limit details that belong in the canvas.",
      "- Migration details that belong in the canvas.",
      "",
      "**Note**",
      "- More caveats that belong in the canvas.",
    ].join("\n");

    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "slackCanvasCreate",
          isError: false,
          content: [{ type: "text", text: "canvas created" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: verboseReply }],
          stopReason: "stop",
        },
      ],
      userInput: "create a reusable reference",
      replyFiles: [],
      artifactStatePatch: {
        lastCanvasUrl: "https://example.invalid/files/F123",
      },
      toolCalls: ["slackCanvasCreate"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      thinkingSelection,
    });

    expect(reply.text).toBe(
      "I created a canvas with the full reference: https://example.invalid/files/F123",
    );
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
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
      thinkingSelection,
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
