import { describe, expect, it } from "vitest";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { buildTurnResult } from "@/chat/services/turn-result";

const executionProfile = {
  profile: "standard",
  reasoningLevel: "medium" as const,
  reason: "test",
};

describe("buildTurnResult", () => {
  it("requires a completed answer after a progress message and tool result", () => {
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
      toolCalls: ["webSearch"],
      generatedFileCount: 0,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
    });

    expect(reply.text).toBe("");
    expect(reply.diagnostics.outcome).toBe("execution_failure");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("requires completed output after a user-visible tool call", () => {
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
      userInput: "Share the report here",
      toolCalls: ["sendFiles"],
      generatedFileCount: 1,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
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
      toolCalls: ["webSearch"],
      generatedFileCount: 0,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
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
      toolCalls: [],
      generatedFileCount: 0,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
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
      toolCalls: [],
      generatedFileCount: 0,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
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
      toolCalls: ["bash"],
      generatedFileCount: 0,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
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
      toolCalls: ["addReaction"],
      generatedFileCount: 0,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
    });

    expect(reply.text).toBe("Handled it.");
    expect(reply.diagnostics.outcome).toBe("success");
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
      toolCalls: [],
      generatedFileCount: 0,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
    });

    expect(reply.text).toBe("");
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("delivers remaining text when a no-reply marker is mixed with prose", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `next model treated that as the whole ask -> ${NO_REPLY_MARKER}`,
            },
          ],
          stopReason: "stop",
        },
      ],
      userInput: "why did you go quiet?",
      toolCalls: [],
      generatedFileCount: 0,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
    });

    expect(reply.text).toBe("next model treated that as the whole ask ->");
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
      toolCalls: ["sendFiles"],
      generatedFileCount: 0,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
    });

    expect(reply.text).toBe("");
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
            attachment_refs: [{ id: "att-1", filename: "chart.png" }],
          },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here's the image." }],
          stopReason: "stop",
        },
      ],
      userInput: "attach it here",
      toolCalls: ["sendFiles"],
      generatedFileCount: 1,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
    });

    expect(reply.text).toBe("Here's the image.");
    expect(reply.diagnostics.outcome).toBe("success");
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
      toolCalls: [],
      durationMs: 1532,
      generatedFileCount: 0,
      shouldTrace: false,
      modelId: "test-model",
      executionProfile,
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
