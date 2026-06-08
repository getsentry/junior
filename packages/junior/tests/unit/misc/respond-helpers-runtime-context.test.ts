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
    // Simulates a thread started by user A (max.topolsky), where the runtime
    // turn context from the first turn was persisted into the session log
    // projection. When user B (nelson.osacky) sends a follow-up message,
    // `loadPiMessagesForTurn` must strip the stale context before returning,
    // so `hasRuntimeTurnContext` returns false and a fresh context block
    // carrying the new requester is injected.
    const projectionWithStaleContext: PiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "<runtime-turn-context>",
              "<requester>",
              "- full_name: Max Topolsky",
              "- user_name: max.topolsky",
              "- user_id: U_MAX",
              "</requester>",
              "</runtime-turn-context>",
            ].join("\n"),
          },
          { type: "text", text: "what command is the plugin using?" },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "it uses sentry-cli build snapshots" }],
        timestamp: 2,
      },
    ] as PiMessage[];

    // Before stripping: stale context is present, so no new context would be injected
    expect(hasRuntimeTurnContext(projectionWithStaleContext)).toBe(true);

    // After stripping (what loadPiMessagesForTurn now does): fresh injection is possible
    const stripped = stripRuntimeTurnContext(projectionWithStaleContext);
    expect(hasRuntimeTurnContext(stripped)).toBe(false);

    const nelsonContext = [
      "<runtime-turn-context>",
      "<requester>",
      "- user_name: nelson.osacky",
      "- user_id: U_NELSON",
      "</requester>",
      "</runtime-turn-context>",
    ].join("\n");
    const updated = prependMissingRuntimeTurnContext(stripped, nelsonContext);

    expect(JSON.stringify(updated)).toContain("nelson.osacky");
    expect(JSON.stringify(updated)).not.toContain("max.topolsky");
    expect(JSON.stringify(updated)).not.toContain("Max Topolsky");
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
