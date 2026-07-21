import { describe, expect, it } from "vitest";

import { NO_REPLY_MARKER } from "@/chat/no-reply";
import {
  buildTurnResult,
  getVisibleAssistantText,
} from "@/chat/services/turn-result";

const reasoningSelection = {
  reasoningLevel: "medium" as const,
  reason: "test",
};

describe("getVisibleAssistantText", () => {
  it("returns visible text without thinking content", () => {
    expect(
      getVisibleAssistantText(
        "<thinking>private reasoning</thinking>Visible answer.",
      ),
    ).toBe("Visible answer.");
  });

  it("suppresses the explicit no-reply marker", () => {
    expect(getVisibleAssistantText(NO_REPLY_MARKER)).toBeUndefined();
  });

  it("suppresses raw tool payload text", () => {
    expect(
      getVisibleAssistantText(
        JSON.stringify({
          type: "tool_call",
          name: "addReaction",
          input: { emoji: "eyes" },
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps prose that quotes a tool payload fragment", () => {
    const text = 'The field `"type": "tool_call"` identifies a tool call.';

    expect(getVisibleAssistantText(text)).toBe(text);
  });
});

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
      artifactStatePatch: {},
      toolCalls: [],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
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
      artifactStatePatch: {},
      toolCalls: ["webSearch"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.diagnostics.outcome).toBe("execution_failure");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("accepts delivered assistant text when no terminal message follows", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I attached the requested file." },
            {
              type: "toolCall",
              id: "call-1",
              name: "sendFiles",
              arguments: { files: [{ path: "/tmp/report.pdf" }] },
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "sendFiles",
          isError: false,
          content: [{ type: "text", text: "uploaded file" }],
        },
      ],
      assistantMessageDelivered: true,
      userInput: "Share the report here",
      artifactStatePatch: {},
      toolCalls: ["sendFiles"],
      generatedFileCount: 1,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({ postThreadText: false });
    expect(reply.diagnostics.outcome).toBe("success");
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
      artifactStatePatch: {},
      toolCalls: ["webSearch"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe("Here is the actual summary.");
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("returns only terminal assistant text after steered user messages", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "first request" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Initial answer." }],
          stopReason: "stop",
        },
        {
          role: "user",
          content: [{ type: "text", text: "actually do this instead" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Updated answer." }],
          stopReason: "stop",
        },
      ],
      userInput: "first request",
      artifactStatePatch: {},
      toolCalls: [],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe("Updated answer.");
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.assistantMessageCount).toBe(2);
  });

  it("removes leaked thinking blocks from terminal assistant text", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            {
              type: "text",
              text: [
                "<thinking>",
                "I should not show this in Slack.",
                "</thinking>",
                "Visible answer.",
                "",
                "```xml",
                "<thinking>example tag</thinking>",
                "```",
              ].join("\n"),
            },
          ],
          stopReason: "stop",
        },
      ],
      userInput: "Do the thing",
      artifactStatePatch: {},
      toolCalls: [],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe(
      [
        "Visible answer.",
        "",
        "```xml",
        "<thinking>example tag</thinking>",
        "```",
      ].join("\n"),
    );
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
      artifactStatePatch: {},
      toolCalls: ["bash"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.diagnostics.outcome).toBe("provider_error");
    expect(reply.diagnostics.errorMessage).toBe(
      "Anthropic stream ended before message_stop",
    );
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("keeps thread text when a turn adds a reaction and returns real text", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "addReaction",
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
      artifactStatePatch: {},
      toolCalls: ["addReaction"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe("Handled it.");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: true,
    });
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("keeps thread delivery enabled for reaction turns that fail validation", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "addReaction",
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
                name: "addReaction",
                input: { reaction: "thumbsup" },
              }),
            },
          ],
          stopReason: "stop",
        },
      ],
      userInput: "react and tell me what happened",
      artifactStatePatch: {},
      toolCalls: ["addReaction"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: true,
    });
    expect(reply.diagnostics.outcome).toBe("execution_failure");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("treats the no-reply marker as intentional silent completion", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: NO_REPLY_MARKER }],
          stopReason: "stop",
        },
      ],
      userInput: "Do whatever makes sense here",
      artifactStatePatch: {},
      toolCalls: [],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: false,
    });
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("treats a no-reply marker mixed with text as silent completion", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: `Done. ${NO_REPLY_MARKER}` }],
          stopReason: "stop",
        },
      ],
      userInput: "Do whatever makes sense here",
      artifactStatePatch: {},
      toolCalls: [],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: false,
    });
    expect(reply.diagnostics.outcome).toBe("success");
  });

  it("keeps no-reply marker silent when side-effect tools also ran", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "sendFiles",
          isError: false,
          content: [{ type: "text", text: "posted in thread" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: NO_REPLY_MARKER }],
          stopReason: "stop",
        },
      ],
      userInput: "share this here without extra commentary",
      artifactStatePatch: {},
      toolCalls: ["sendFiles"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: false,
    });
    expect(reply.diagnostics.outcome).toBe("success");
  });

  it("does not correct attachment claims after sendFiles sends files", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "sendFiles",
          isError: false,
          content: [{ type: "text", text: "uploaded file" }],
          details: {
            ok: true,
            channel_id: "C123",
            thread_ts: "1700000000.321",
            file_count: 1,
            file_ids: ["F123"],
          },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here's the image." }],
          stopReason: "stop",
        },
      ],
      userInput: "attach it here",
      artifactStatePatch: {},
      toolCalls: ["sendFiles"],
      generatedFileCount: 1,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
    });

    expect(reply.text).toBe("Here's the image.");
    expect(reply.diagnostics.outcome).toBe("success");
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
      artifactStatePatch: {
        lastCanvasUrl: "https://example.invalid/files/F123",
      },
      toolCalls: ["slackCanvasCreate"],
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
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
      artifactStatePatch: {},
      toolCalls: [],
      durationMs: 1532,
      generatedFileCount: 0,
      shouldTrace: false,
      spanContext: {},
      modelId: "test-model",
      reasoningSelection,
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
