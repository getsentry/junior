import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { prependMissingRuntimeTurnContext } from "@/chat/agent-run-helpers";

describe("prependMissingRuntimeTurnContext", () => {
  it("leaves recorded bootstrap prompts unchanged", () => {
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

    const updated = prependMissingRuntimeTurnContext(
      messages,
      [
        "<runtime-turn-context>",
        "<runtime>",
        "- gen_ai.conversation.id: slack:C123:updated",
        "</runtime>",
        "</runtime-turn-context>",
      ].join("\n"),
    );

    expect(updated).toBe(messages);
    expect(JSON.stringify(updated[0])).toContain(
      "- gen_ai.conversation.id: slack:C123:1712345.000001",
    );
    expect(JSON.stringify(updated[0])).toContain(
      "- slack.conversation.name: #engineering",
    );
    expect(JSON.stringify(updated[0])).not.toContain("slack:C123:updated");
  });

  it("adds bootstrap context to a pre-prompt user boundary", () => {
    const messages: PiMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "help me ship this" }],
        timestamp: 1,
      },
    ] as PiMessage[];

    const updated = prependMissingRuntimeTurnContext(
      messages,
      [
        "<runtime-turn-context>",
        "<runtime>",
        "- gen_ai.conversation.id: slack:C123:1712345.000001",
        "</runtime>",
        "</runtime-turn-context>",
      ].join("\n"),
    );

    expect(updated[0]).not.toBe(messages[0]);
    expect(JSON.stringify(updated[0])).toContain("<runtime-turn-context>");
    expect(JSON.stringify(updated[0])).toContain("help me ship this");
  });
});
