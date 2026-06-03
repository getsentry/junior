import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { refreshRuntimeTurnContext } from "@/chat/respond-helpers";

describe("refreshRuntimeTurnContext", () => {
  it("preserves Slack conversation facts from the recorded bootstrap prompt", () => {
    const messages: PiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "<runtime-turn-context>",
              "<runtime>",
              "- gen_ai.conversation.id: slack:C123:1712345.000001",
              "- slack.conversation.type: public_channel",
              "- slack.conversation.name: #engineering",
              "</runtime>",
              "</runtime-turn-context>",
            ].join("\n"),
          },
          { type: "text", text: "help me ship this" },
        ],
        timestamp: 1,
      },
    ] as PiMessage[];

    const refreshed = refreshRuntimeTurnContext(
      messages,
      [
        "<runtime-turn-context>",
        "<runtime>",
        "- gen_ai.conversation.id: slack:C123:1712345.000001",
        "</runtime>",
        "<context>",
        "<configuration>",
        "- sentry_project: junior",
        "</configuration>",
        "</context>",
        "</runtime-turn-context>",
      ].join("\n"),
    );

    expect(refreshed[0]).not.toBe(messages[0]);
    expect(JSON.stringify(refreshed[0])).toContain(
      "- slack.conversation.type: public_channel",
    );
    expect(JSON.stringify(refreshed[0])).toContain(
      "- slack.conversation.name: #engineering",
    );
    expect(JSON.stringify(refreshed[0])).toContain("help me ship this");
  });
});
