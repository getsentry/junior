import { afterEach, describe, expect, it } from "vitest";
import { botConfig } from "@/chat/config";
import { ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";
import { closeConversationFixture } from "../fixtures/conversation";
import { createAgent } from "../fixtures/agent";
import { mockTitleModel } from "../fixtures/title-model";

const originalBotConfig = { ...botConfig };
const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;

function mockCompactionSummary(text: string): void {
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
  mockTitleModel(text);
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
    mockCompactionSummary(
      "Earlier work is complete. Continue with the new ask.",
    );
    const oldReply = `Old result: ${"x".repeat(152_000)}`;
    const agent = await createAgent({
      botConfig: { contextWindowTokens: 50_000 },
      history: [{ prompt: "do the earlier work", reply: oldReply }],
      replies: ["Working on the new request.", "New request completed."],
    });

    await agent.run("do the new work");

    const events = await agent.events();
    const messages = await agent.messages();
    expect(JSON.stringify(messages)).not.toContain(oldReply);
    expect(JSON.stringify(messages)).toContain("New request completed.");
    expect(JSON.stringify(messages)).toContain(
      ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX,
    );
    expect(events.some((event) => event.data.type === "compaction")).toBe(true);
    expect(events.at(-1)?.data).toMatchObject({
      type: "turn_completed",
      outcome: "success",
    });
  }, 15_000);
});
