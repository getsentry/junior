import { describe, expect, it } from "vitest";
import { buildTurnResult } from "@/chat/services/turn-result";

describe("buildTurnResult", () => {
  it("keeps diagnostics aligned with oauth fallback outcomes", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "toolResult",
          toolName: "bash",
          isError: false,
          stdout: JSON.stringify({
            credential_unavailable: true,
            oauth_started: true,
            provider: "github",
            message:
              "I need to connect your GitHub account first. I've sent you a private authorization link.",
          }),
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
      "I need to connect your GitHub account first. I've sent you a private authorization link.",
    );
    expect(reply.diagnostics.outcome).toBe("success");
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
});
