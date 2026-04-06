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
      hasTextDeltaCallback: false,
      shouldTrace: false,
      spanContext: {},
    });

    expect(reply.text).toBe(
      "I need to connect your GitHub account first. I've sent you a private authorization link.",
    );
    expect(reply.diagnostics.outcome).toBe("success");
  });
});
