import { afterEach, describe, expect, it } from "vitest";
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
const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;

/** Use the normal utility-model HTTP edge for the compaction summary. */
function mockCompactionSummary(text: string): void {
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
  mockTitleModel(text);
}

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
    if (originalGatewayKey === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
    }
    await closeConversationFixture();
  });
  it("keeps earlier model messages unchanged", async () => {
    const agent = await createAgent();

    await agent.run("first request");
    const first = agent.snapshot();

    await agent.run("second request");
    const second = agent.snapshot();

    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
  });

  it("compacts preloaded history and completes the active turn", async () => {
    mockCompactionSummary(COMPACTION_SUMMARY);

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
