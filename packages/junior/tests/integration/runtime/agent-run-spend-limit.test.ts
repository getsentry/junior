import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource, type Destination } from "@sentry/junior-plugin-api";

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
import { persistCompletedSessionRecord } from "@/chat/services/turn-session-record";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { TURN_SPEND_LIMIT_RESPONSE } from "@/chat/services/spend-limit";

const ORIGINAL_STATE_ADAPTER = process.env.JUNIOR_STATE_ADAPTER;

/** Build a Slack route that the SQL-backed integration harness can persist. */
function createTestRoute(channelId: string, threadTs: string) {
  const destination = {
    platform: "slack",
    teamId: "TSPEND",
    channelId,
  } satisfies Destination;
  return {
    conversationId: `slack:${channelId}:${threadTs}`,
    destination,
    source: createSlackSource({
      teamId: destination.teamId,
      channelId,
      threadTs,
      type: "priv",
    }),
  };
}

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
    const channelId = includeCost ? "CSPENDCOST" : "CSPENDMISSING";
    const threadTs = includeCost ? "1712345.0001" : "1712345.0002";
    const { conversationId, destination, source } = createTestRoute(
      channelId,
      threadTs,
    );
    const delivered: string[] = [];

    const outcome = await executeAgentRun({
      conversationId,
      turnId: `turn-spend-limit-${includeCost}`,
      input: { messageText: "keep working" },
      routing: {
        destination,
        source,
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
        piMessages: [
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
        ],
        diagnostics: {
          outcome: "success",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
          },
        },
      },
    });

    if (outcome.status !== "completed") {
      throw new Error("Expected a completed spend-limit result");
    }
    await persistCompletedSessionRecord({
      conversationId,
      sessionId: `turn-spend-limit-${includeCost}`,
      sliceId: 1,
      allMessages: outcome.result.piMessages ?? [],
      modelId: outcome.result.diagnostics.modelId,
      currentUsage: outcome.result.diagnostics.usage,
      destination,
      source,
    });

    const nextDelivered: string[] = [];
    await executeAgentRun({
      conversationId,
      turnId: `turn-spend-limit-next-${includeCost}`,
      input: { messageText: "try again" },
      routing: {
        destination,
        source,
      },
      delivery: {
        onAssistantMessage: ({ text }) => {
          nextDelivered.push(text);
        },
      },
    });

    expect(provider.calls).toBe(1);
    expect(nextDelivered).toEqual([TURN_SPEND_LIMIT_RESPONSE]);
  });

  it("fails closed when new provider usage omits cost after prior spend", async () => {
    const { conversationId, destination, source } = createTestRoute(
      "CSPENDPRIOR",
      "1712345.0003",
    );
    await persistCompletedSessionRecord({
      conversationId,
      sessionId: "turn-prior-cost",
      sliceId: 1,
      allMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "previous request" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "previous response" }],
          stopReason: "stop",
          api: "test",
          provider: "test",
          model: "test-model",
          timestamp: 2,
          usage: {
            input: 2,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: {
              input: 0.2,
              output: 0.05,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.25,
            },
          },
        },
      ],
      modelId: "test-model",
      destination,
      source,
      currentUsage: {
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
        cost: { total: 0.25 },
      },
    });
    provider.includeCost = false;
    const delivered: string[] = [];

    await executeAgentRun({
      conversationId,
      turnId: "turn-missing-cost-after-prior-spend",
      input: { messageText: "keep working" },
      routing: {
        destination,
        source,
      },
      delivery: {
        onAssistantMessage: ({ text }) => {
          delivered.push(text);
        },
      },
    });

    expect(provider.calls).toBe(1);
    expect(delivered).toEqual([TURN_SPEND_LIMIT_RESPONSE]);
  });
});
