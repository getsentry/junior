import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";

const provider = vi.hoisted(() => ({
  calls: 0,
  includeCost: true,
}));

vi.mock("@/chat/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/config")>();
  const config = actual.readChatConfig({
    ...process.env,
    MAX_SPEND: "1",
  });
  return { ...actual, botConfig: config.bot };
});

vi.mock("@/chat/pi/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/pi/client")>();
  return {
    ...actual,
    completeObject: async () => ({
      object: {
        reasoning_level: "medium",
        profile: "standard",
        confidence: 1,
        reason: "test",
      },
    }),
  };
});

vi.mock("@/chat/pi/traced-stream", () => ({
  createTracedStreamFn: () => async (model: { id: string }) => {
    provider.calls += 1;
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "This must not be delivered." }],
      stopReason: "stop" as const,
      api: "test",
      provider: "test",
      model: model.id,
      timestamp: Date.now(),
      usage: {
        input: 10,
        output: 5,
        totalTokens: 15,
        ...(provider.includeCost ? { cost: { total: 1 } } : {}),
      },
    };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done" as const, reason: "stop", message };
      },
      result: async () => message,
    };
  },
}));

vi.mock("@/chat/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/skills")>()),
  discoverSkills: async () => [],
  findSkillByName: () => null,
  parseSkillInvocation: () => null,
}));

import { executeAgentRun } from "@/chat/agent";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { TURN_SPEND_LIMIT_RESPONSE } from "@/chat/services/spend-limit";

const ORIGINAL_STATE_ADAPTER = process.env.JUNIOR_STATE_ADAPTER;

describe("executeAgentRun spend limit", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    provider.calls = 0;
    provider.includeCost = true;
    await disconnectStateAdapter();
  });

  afterAll(async () => {
    await disconnectStateAdapter();
    if (ORIGINAL_STATE_ADAPTER === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = ORIGINAL_STATE_ADAPTER;
    }
  });

  it.each([
    ["reported spend reaches the cap", true],
    ["provider omits cost data", false],
  ])("delivers a static response when %s", async (_case, includeCost) => {
    provider.includeCost = includeCost;
    const conversationId = `local:test:spend-limit:${includeCost}`;
    const delivered: string[] = [];

    const outcome = await executeAgentRun({
      conversationId,
      turnId: `turn-spend-limit-${includeCost}`,
      input: { messageText: "keep working" },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
      },
      delivery: {
        onAssistantMessage: ({ text }) => {
          delivered.push(text);
        },
      },
    });

    expect(provider.calls).toBe(1);
    expect(delivered).toEqual([TURN_SPEND_LIMIT_RESPONSE]);
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        text: TURN_SPEND_LIMIT_RESPONSE,
        diagnostics: { outcome: "success" },
      },
    });
  });
});
