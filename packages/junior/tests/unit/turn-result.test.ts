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
      renderedCards: [],
      toolCalls: [],
      generatedFileCount: 0,
      hasTextDeltaCallback: false,
      shouldTrace: false,
      spanContext: {},
    });

    expect(reply.text).toBe(
      "I need to connect your GitHub account first. I've sent you a private authorization link.",
    );
    expect(reply.diagnostics.outcome).toBe("success");
  });

  it("treats card-only turns as successful replies without fallback text", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
        },
      ],
      userInput: "show me the issue",
      replyFiles: [],
      artifactStatePatch: {},
      renderedCards: [
        {
          cardElement: { type: "card" } as never,
          entityKey: "github.issue:42",
          pluginName: "github",
          fallbackText: "#42: Fix the bug (open)",
        },
      ],
      toolCalls: ["renderCard"],
      generatedFileCount: 0,
      hasTextDeltaCallback: false,
      shouldTrace: false,
      spanContext: {},
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      mode: "thread",
      postThreadText: false,
    });
    expect(reply.renderedCards).toHaveLength(1);
    expect(reply.diagnostics.outcome).toBe("success");
  });

  it("drops structured text that duplicates a single rendered card", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "Most recent issue in junior:",
                "JUNIOR-1G - Error: An API error occurred",
                "• Status: unresolved",
                "• Project: junior",
                "• View in Sentry",
                "Want me to dig into the recent events?",
              ].join("\n"),
            },
          ],
          stopReason: "stop",
        },
      ],
      userInput: "show me the most recent issue",
      replyFiles: [],
      artifactStatePatch: {},
      renderedCards: [
        {
          cardElement: { type: "card" } as never,
          entityKey: "sentry.issue:JUNIOR-1G",
          pluginName: "sentry",
          fallbackText: "JUNIOR-1G: Error: An API error occurred (unresolved)",
          dedupeTextLines: [
            "JUNIOR-1G",
            "Error: An API error occurred",
            "JUNIOR-1G: Error: An API error occurred",
            "Status: unresolved",
            "Project: junior",
            "View in Sentry",
          ],
        },
      ],
      toolCalls: ["renderCard"],
      generatedFileCount: 0,
      hasTextDeltaCallback: false,
      shouldTrace: false,
      spanContext: {},
    });

    expect(reply.text).toBe("Want me to dig into the recent events?");
  });

  it("suppresses thread text when only a redundant card intro remains", () => {
    const reply = buildTurnResult({
      newMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Most recent issue in junior:",
            },
          ],
          stopReason: "stop",
        },
      ],
      userInput: "show me the most recent issue",
      replyFiles: [],
      artifactStatePatch: {},
      renderedCards: [
        {
          cardElement: { type: "card" } as never,
          entityKey: "sentry.issue:JUNIOR-1G",
          pluginName: "sentry",
          fallbackText: "JUNIOR-1G: Error: An API error occurred (unresolved)",
          dedupeTextLines: ["JUNIOR-1G", "Error: An API error occurred"],
        },
      ],
      toolCalls: ["renderCard"],
      generatedFileCount: 0,
      hasTextDeltaCallback: false,
      shouldTrace: false,
      spanContext: {},
    });

    expect(reply.text).toBe("");
    expect(reply.deliveryPlan).toMatchObject({
      mode: "thread",
      postThreadText: false,
    });
  });
});
