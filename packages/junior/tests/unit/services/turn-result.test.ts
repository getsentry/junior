import { describe, expect, it } from "vitest";

import {
  buildTurnResult,
  type TurnResultInput,
} from "@/chat/services/turn-result";

const thinkingSelection = {
  thinkingLevel: "medium" as const,
  reason: "test",
};

type TurnResultCase = Partial<Omit<TurnResultInput, "newMessages">> &
  Pick<TurnResultInput, "newMessages">;

function resultFor(input: TurnResultCase) {
  return buildTurnResult({
    userInput: "Do the thing",
    replyFiles: [],
    artifactStatePatch: {},
    toolCalls: [],
    generatedFileCount: 0,
    shouldTrace: false,
    spanContext: {},
    thinkingSelection,
    ...input,
  });
}

function textMessage(
  role: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    role,
    content: [{ type: "text", text }],
    ...extra,
  };
}

function user(text: string) {
  return textMessage("user", text);
}

function assistant(text: string, extra: Record<string, unknown> = {}) {
  return textMessage("assistant", text, extra);
}

function toolResult(
  toolName: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return textMessage("toolResult", text, {
    toolName,
    isError: false,
    ...extra,
  });
}

describe("buildTurnResult", () => {
  it("treats empty tool-only turns as execution failures", () => {
    const reply = resultFor({
      newMessages: [
        {
          role: "toolResult",
          toolName: "bash",
          isError: false,
          stdout: "ok",
        },
        assistant("I don't have access to active tool.", {
          stopReason: "stop",
        }),
      ],
      userInput: "Open the GitHub issue",
    });

    expect(reply.text).toBe("");
    expect(reply.diagnostics.outcome).toBe("execution_failure");
  });

  it("ignores provisional assistant text that appears before the last tool result", () => {
    const reply = resultFor({
      newMessages: [
        assistant("Let me go check the latest articles and compare them."),
        toolResult("webSearch", "search results"),
      ],
      userInput: "Pull the latest blog post and compare related articles",
      toolCalls: ["webSearch"],
    });

    expect(reply.text).toBe("");
    expect(reply.diagnostics.outcome).toBe("execution_failure");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("uses only terminal assistant text after tool results", () => {
    const reply = resultFor({
      newMessages: [
        assistant("Let me check that."),
        toolResult("webSearch", "search results"),
        assistant("Here is the actual summary.", {
          stopReason: "stop",
        }),
      ],
      userInput: "Pull the latest blog post and compare related articles",
      toolCalls: ["webSearch"],
    });

    expect(reply.text).toBe("Here is the actual summary.");
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("keeps assistant text across steered user messages", () => {
    const reply = resultFor({
      newMessages: [
        user("first request"),
        assistant("Initial answer.", {
          stopReason: "stop",
        }),
        user("actually do this instead"),
        assistant("Updated answer.", {
          stopReason: "stop",
        }),
      ],
      userInput: "first request",
    });

    expect(reply.text).toBe(
      ["Initial answer.", "Updated answer."].join("\n\n"),
    );
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.assistantMessageCount).toBe(2);
  });

  it("removes leaked thinking blocks from terminal assistant text", () => {
    const reply = resultFor({
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
    const reply = resultFor({
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
      toolCalls: ["bash"],
    });

    expect(reply.text).toBe("");
    expect(reply.diagnostics.outcome).toBe("provider_error");
    expect(reply.diagnostics.errorMessage).toBe(
      "Anthropic stream ended before message_stop",
    );
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("treats reaction-only turns as successful without fallback text", () => {
    const reply = resultFor({
      newMessages: [toolResult("slackMessageAddReaction", "reaction added")],
      userInput: "react to this",
      toolCalls: ["slackMessageAddReaction"],
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: false,
    });
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(false);
  });

  it("suppresses empty thread text when a channel post is the successful side effect", () => {
    const reply = resultFor({
      newMessages: [toolResult("slackChannelPostMessage", "message posted")],
      userInput: "share the update",
      toolCalls: ["slackChannelPostMessage"],
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
    const reply = resultFor({
      newMessages: [
        toolResult("slackMessageAddReaction", "reaction added"),
        assistant("Handled it.", {
          stopReason: "stop",
        }),
      ],
      userInput: "react and confirm",
      toolCalls: ["slackMessageAddReaction"],
    });

    expect(reply.text).toBe("Handled it.");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: true,
    });
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("suppresses model text for reaction-only requests", () => {
    const reply = resultFor({
      newMessages: [
        toolResult("slackMessageAddReaction", "reaction added"),
        assistant("արձագանքեցի :thumbsup:", {
          stopReason: "stop",
        }),
      ],
      userInput: "react to this",
      toolCalls: ["slackMessageAddReaction"],
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      postThreadText: false,
    });
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("keeps thread delivery enabled for reaction turns that fail validation", () => {
    const reply = resultFor({
      newMessages: [
        toolResult("slackMessageAddReaction", "reaction added"),
        assistant(
          JSON.stringify({
            type: "tool_call",
            name: "slackMessageAddReaction",
            input: { reaction: "thumbsup" },
          }),
          {
            stopReason: "stop",
          },
        ),
      ],
      userInput: "react and tell me what happened",
      toolCalls: ["slackMessageAddReaction"],
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

    const reply = resultFor({
      newMessages: [
        toolResult("slackCanvasCreate", "canvas created"),
        assistant(verboseReply, {
          stopReason: "stop",
        }),
      ],
      userInput: "create a reusable reference",
      artifactStatePatch: {
        lastCanvasUrl: "https://example.invalid/files/F123",
      },
      toolCalls: ["slackCanvasCreate"],
    });

    expect(reply.text).toBe(
      "I created a canvas with the full reference: https://example.invalid/files/F123",
    );
    expect(reply.diagnostics.outcome).toBe("success");
    expect(reply.diagnostics.usedPrimaryText).toBe(true);
  });

  it("preserves structured timing and usage diagnostics", () => {
    const reply = resultFor({
      newMessages: [
        assistant("Done.", {
          stopReason: "stop",
        }),
      ],
      durationMs: 1532,
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
