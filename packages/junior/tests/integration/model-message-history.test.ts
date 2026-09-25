import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  mockAnthropicStream,
  withoutCacheMarkers,
} from "../fixtures/anthropic-stream";
import { botConfig } from "@/chat/config";
import type { PiMessage } from "@/chat/pi/messages";
import { ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";
import { closeConversationFixture } from "../fixtures/conversation";
import { createAgent } from "../fixtures/agent";
import { mockTitleModel } from "../fixtures/title-model";

const TEST_CONTEXT_WINDOW_TOKENS = 50_000;
const LARGE_HISTORY_CHARS = 152_000;
const OLD_HISTORY_MARKER = "Old result:";
const COMPACTION_SUMMARY =
  "Earlier work is complete. Continue with the new ask.";
const FINAL_RESPONSE = "New request completed.";
const originalBotConfig = { ...botConfig };

function textFromAgentHistory(messages: PiMessage[]): string {
  const text: string[] = [];
  for (const message of messages) {
    if (!("content" in message) || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if ("text" in part && typeof part.text === "string") {
        text.push(part.text);
      }
    }
  }
  return text.join("\n");
}

describe("model message history", () => {
  afterEach(async () => {
    Object.assign(botConfig, originalBotConfig);
    await closeConversationFixture();
  });
  it("preserves native messages and provider request prefixes across Turns", async () => {
    const toolArguments = {
      explanation: "Check the result\u0000before replying.",
      plan: [
        { status: "in_progress", step: "Check the result" },
        { status: "pending", step: "Reply to the user" },
      ],
    };
    mockTitleModel("Conversation title");
    const requests = mockAnthropicStream("openai/gpt-6-astra", [
      [
        {
          type: "thinking",
          thinking: "Check the plan.",
          signature: "opaque-signature",
        },
        { type: "redacted_thinking", data: "opaque-redacted-data" },
        {
          type: "tool_use",
          id: "plan-call",
          name: "updatePlan",
          input: toolArguments,
        },
      ],
      [{ type: "text", text: "First response." }],
      [{ type: "text", text: "Second response." }],
    ]);
    const agent = await createAgent({
      modelStream: streamSimple,
      botConfig: {
        defaultProfile: "standard",
        profiles: {
          standard: { modelId: "openai/gpt-6-astra", reasoningLevel: "low" },
        },
      },
    });

    await agent.run("first\u0000request and literal \\u0000");
    const first = agent.snapshot();

    await agent.run("second request");
    const second = agent.snapshot();

    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    expect(first.messages).toContainEqual(
      expect.objectContaining({ role: "toolResult", isError: false }),
    );
    const firstAssistant = first.messages.find(
      (message) => message.role === "assistant",
    );
    expect(firstAssistant?.content).toMatchObject([
      { type: "thinking", thinkingSignature: "opaque-signature" },
      {
        type: "thinking",
        thinkingSignature: "opaque-redacted-data",
        redacted: true,
      },
      { type: "toolCall", arguments: toolArguments },
    ]);
    const stored = await agent.agentHistory();
    expect(
      JSON.stringify(
        stored.find((message) => message.role === "assistant")?.content,
      ),
    ).toBe(JSON.stringify(firstAssistant?.content));
    expect(stored.slice(0, first.messages.length)).toEqual(first.messages);
    expect(requests).toHaveLength(3);
    const before = requests[1]!;
    const after = requests[2]!;
    expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
    // Do not sort in the assertion: the real provider bytes must already match.
    expect(
      JSON.stringify(
        withoutCacheMarkers(after.messages.slice(0, before.messages.length)),
      ),
    ).toBe(JSON.stringify(withoutCacheMarkers(before.messages)));
  });

  it("compacts preloaded history and completes the active turn", async () => {
    mockTitleModel(COMPACTION_SUMMARY);

    // Keep this test cheap. The 50k context window makes the normal 90%
    // compaction threshold 45k tokens. This response pads the durable history
    // enough to cross that threshold during the next Turn.
    const largePreviousResponse =
      `${OLD_HISTORY_MARKER} ` + "x".repeat(LARGE_HISTORY_CHARS);
    const agent = await createAgent({
      botConfig: { contextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS },
      previousTurns: [
        { prompt: "do the earlier work", response: largePreviousResponse },
      ],
      // The first response reaches Pi's next model-request boundary. Compaction
      // runs there, then the second response proves the same Turn continues.
      responses: ["Working on the new request.", FINAL_RESPONSE],
    });

    await agent.run("do the new work");

    const historyEvents = await agent.historyEvents();
    const agentHistoryText = textFromAgentHistory(await agent.agentHistory());
    expect(agentHistoryText).not.toContain(OLD_HISTORY_MARKER);
    expect(agentHistoryText).toContain(COMPACTION_SUMMARY);
    expect(agentHistoryText).toContain(ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX);
    expect(agentHistoryText).toContain(FINAL_RESPONSE);
    expect(
      historyEvents.some((event) => event.data.type === "compaction"),
    ).toBe(true);
    expect(historyEvents.at(-1)?.data).toMatchObject({
      type: "turn_completed",
      outcome: "success",
    });
  }, 15_000);
});
