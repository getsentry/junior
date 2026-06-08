import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  hasRuntimeTurnContext,
  prependMissingRuntimeTurnContext,
  stripRuntimeTurnContext,
} from "@/chat/respond-helpers";

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

  it("injects new requester context after stripping stale projected context", () => {
    // Simulates a thread started by user A, where the runtime turn context
    // from the first turn was persisted into the session log projection.
    // When user B sends a follow-up message, `loadPiMessagesForTurn` must
    // strip the stale context before returning, so `hasRuntimeTurnContext`
    // returns false and a fresh context block carrying user B's identity
    // is injected instead.
    const projectionWithStaleContext: PiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "<runtime-turn-context>",
              "<requester>",
              "- full_name: User Alpha",
              "- user_name: user.alpha",
              "- user_id: U_ALPHA",
              "</requester>",
              "</runtime-turn-context>",
            ].join("\n"),
          },
          { type: "text", text: "original question" },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "original answer" }],
        timestamp: 2,
      },
    ] as PiMessage[];

    // Before stripping: stale context is present, so no new context would be injected
    expect(hasRuntimeTurnContext(projectionWithStaleContext)).toBe(true);

    // After stripping (what loadPiMessagesForTurn now does): fresh injection is possible
    const stripped = stripRuntimeTurnContext(projectionWithStaleContext);
    expect(hasRuntimeTurnContext(stripped)).toBe(false);

    const userBContext = [
      "<runtime-turn-context>",
      "<requester>",
      "- user_name: user.beta",
      "- user_id: U_BETA",
      "</requester>",
      "</runtime-turn-context>",
    ].join("\n");
    const updated = prependMissingRuntimeTurnContext(stripped, userBContext);

    expect(JSON.stringify(updated)).toContain("user.beta");
    expect(JSON.stringify(updated)).not.toContain("user.alpha");
    expect(JSON.stringify(updated)).not.toContain("User Alpha");
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
