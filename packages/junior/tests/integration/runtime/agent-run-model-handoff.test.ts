import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";

const observations = vi.hoisted(() => ({
  afterHandoffModelId: "",
  afterHandoffMessages: [] as Array<{
    role?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  }>,
  afterHandoffToolNames: [] as string[],
  initialModelId: "",
  initialToolNames: [] as string[],
  mixedBatch: false,
  progressTool: false,
  providerCalls: 0,
  requestedProfile: undefined as string | null | undefined,
  routedReasoningLevel: "high",
  reasoningLevels: [] as string[],
  summaryCalls: 0,
  handoffStatusBeforeSummary: false,
  statuses: [] as string[],
}));

vi.mock("@/chat/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/config")>();
  const config = actual.readChatConfig({
    ...process.env,
    AI_HANDOFF_MODEL: "openai/gpt-5.6-sol",
    AI_MODEL_PROFILES: JSON.stringify({ coding: "openai/gpt-5.4" }),
  });
  return { ...actual, botConfig: config.bot };
});

vi.mock("@/chat/pi/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/pi/client")>();
  return {
    ...actual,
    completeObject: async () => ({
      object: {
        reasoning_level: observations.routedReasoningLevel,
        confidence: 0.99,
        reason: "complex implementation",
      },
    }),
    completeText: async () => {
      observations.handoffStatusBeforeSummary =
        observations.statuses.includes("Switching models");
      observations.summaryCalls += 1;
      return { text: "Implement the requested change and verify it." };
    },
  };
});

vi.mock("@/chat/pi/traced-stream", () => ({
  createTracedStreamFn:
    () => async (model: any, context: any, options: any) => {
      observations.providerCalls += 1;
      observations.reasoningLevels.push(options?.reasoning ?? "unset");
      const call = observations.providerCalls;
      if (call === 1) {
        observations.initialModelId = model.id;
        observations.initialToolNames = (context.tools ?? []).map(
          (tool: { name: string }) => tool.name,
        );
      } else {
        observations.afterHandoffModelId = model.id;
        observations.afterHandoffMessages = context.messages ?? [];
        observations.afterHandoffToolNames = (context.tools ?? []).map(
          (tool: { name: string }) => tool.name,
        );
      }

      const text =
        call === 1
          ? observations.progressTool
            ? "Let me do that now."
            : "The standard model started an answer that must be hidden."
          : observations.mixedBatch
            ? "Standard model recovered safely."
            : "Handoff model completed it.";
      const content: Array<Record<string, unknown>> = [{ type: "text", text }];
      if (call === 1) {
        content.push({
          type: "toolCall",
          id: observations.progressTool ? "progress-call-1" : "handoff-call-1",
          name: observations.progressTool ? "reportProgress" : "handoff",
          arguments: observations.progressTool
            ? { message: "Checking details" }
            : observations.requestedProfile === undefined
              ? {}
              : { profile: observations.requestedProfile },
        });
        if (observations.mixedBatch && !observations.progressTool) {
          content.push({
            type: "toolCall",
            id: "bash-call-1",
            name: "bash",
            arguments: { command: "touch should-not-run" },
          });
        }
      }
      const message = {
        role: "assistant",
        content,
        stopReason: call === 1 ? "toolUse" : "stop",
        api: "test",
        provider: "test",
        model: model.id,
        timestamp: Date.now(),
        usage:
          call === 1
            ? { input: 2, output: 1, totalTokens: 3 }
            : observations.mixedBatch
              ? { input: 2, output: 2, totalTokens: 4 }
              : { input: 4, output: 3, totalTokens: 7 },
      };
      const partial = { ...message, content: [] };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial };
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: text,
            partial: {
              ...message,
              content: [{ type: "text", text }],
            },
          };
          yield {
            type: "done",
            reason: message.stopReason,
            message,
          };
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
import {
  loadConversationProjection,
  loadProjection,
} from "@/chat/conversations/projection";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { getConversationEventStore } from "@/chat/db";

const ORIGINAL_STATE_ADAPTER = process.env.JUNIOR_STATE_ADAPTER;

function expectedHandoffReplacementHistory() {
  return [
    {
      message: {
        role: "user",
        timestamp: expect.any(Number),
        content: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining(
              "<current-instruction>\nModel handoff checkpoint.",
            ),
          }),
        ],
      },
      provenance: { authority: "context" },
    },
  ];
}

describe("executeAgentRun model handoff", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    observations.afterHandoffModelId = "";
    observations.afterHandoffMessages = [];
    observations.afterHandoffToolNames = [];
    observations.initialModelId = "";
    observations.initialToolNames = [];
    observations.mixedBatch = false;
    observations.progressTool = false;
    observations.providerCalls = 0;
    observations.requestedProfile = undefined;
    observations.routedReasoningLevel = "high";
    observations.reasoningLevels = [];
    observations.summaryCalls = 0;
    observations.handoffStatusBeforeSummary = false;
    observations.statuses = [];
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    if (ORIGINAL_STATE_ADAPTER === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = ORIGINAL_STATE_ADAPTER;
    }
  });

  it("compacts and upgrades the same conversation before continuing the turn", async () => {
    observations.requestedProfile = null;
    const conversationId = "local:test:model-handoff";
    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-model-handoff",
      turnId: "turn-model-handoff",
      input: { messageText: "Implement the multi-file refactor." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
      },
      observers: {
        onStatus: ({ text }) => {
          observations.statuses.push(text);
        },
      },
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.text).toBe("Handoff model completed it.");
    expect(outcome.result.diagnostics.modelId).toBe("openai/gpt-5.6-sol");
    expect(
      (outcome.result.diagnostics.usage?.inputTokens ?? 0) +
        (outcome.result.diagnostics.usage?.outputTokens ?? 0),
    ).toBe(10);
    expect(observations.initialModelId).not.toBe(
      observations.afterHandoffModelId,
    );
    expect(observations.afterHandoffModelId).toBe("openai/gpt-5.6-sol");
    expect(observations.reasoningLevels.slice(0, 2)).toEqual(["high", "high"]);
    expect(observations.afterHandoffToolNames).not.toContain("handoff");
    expect(observations.afterHandoffToolNames).toEqual(
      observations.initialToolNames.filter((name) => name !== "handoff"),
    );
    expect(observations.summaryCalls).toBe(1);
    expect(observations.handoffStatusBeforeSummary).toBe(true);
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("handoff");
    const handoffs = (
      await getConversationEventStore().loadHistory(conversationId)
    )
      .map((event) => event.data)
      .filter((entry) => entry.type === "handoff");
    expect(handoffs).toEqual([
      {
        type: "handoff",
        modelProfile: "handoff",
        modelId: "openai/gpt-5.6-sol",
        triggeringToolCallId: "handoff-call-1",
        replacementHistory: expectedHandoffReplacementHistory(),
      },
    ]);
    const projection = await loadProjection({ conversationId });
    expect(projection).toHaveLength(1);
    expect(JSON.stringify(projection)).toContain(
      "Implement the requested change and verify it.",
    );
    expect(outcome.result.piMessages?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(observations.afterHandoffMessages).toHaveLength(1);
    expect(observations.afterHandoffMessages[0]?.role).toBe("user");
    expect(observations.afterHandoffMessages[0]?.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("<runtime-turn-context>"),
      }),
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(
          "<current-instruction>\nModel handoff checkpoint.",
        ),
      }),
    ]);

    const followUp = await executeAgentRun({
      conversationId,
      runId: "run-model-handoff-follow-up",
      turnId: "turn-model-handoff-follow-up",
      input: { messageText: "Now explain the verification result." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
      },
    });
    expect(followUp.status).toBe("completed");
    if (followUp.status !== "completed") return;
    expect(followUp.result.diagnostics.modelId).toBe("openai/gpt-5.6-sol");
    expect(observations.providerCalls).toBe(3);
    expect(observations.afterHandoffModelId).toBe("openai/gpt-5.6-sol");
    expect(observations.afterHandoffToolNames).not.toContain("handoff");
    expect(observations.summaryCalls).toBe(1);
  });

  it("delivers completed assistant messages in model order", async () => {
    observations.progressTool = true;
    const delivered: Array<{ text: string }> = [];
    const conversationId = "local:test:assistant-message-delivery";

    const outcome = await executeAgentRun({
      conversationId,
      turnId: "turn-assistant-message-delivery",
      input: { messageText: "Check the details." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
      },
      delivery: {
        onAssistantMessage: (message) => {
          delivered.push(message);
        },
      },
    });

    expect(outcome.status).toBe("completed");
    expect(delivered).toEqual([
      { text: "Let me do that now." },
      { text: "Handoff model completed it." },
    ]);
  });

  it("propagates delivery failure before the agent executes the tool", async () => {
    observations.progressTool = true;
    const deliveryError = new Error("destination unavailable");
    const conversationId = "local:test:assistant-message-delivery-failure";

    await expect(
      executeAgentRun({
        conversationId,
        turnId: "turn-assistant-message-delivery-failure",
        input: { messageText: "Check the details." },
        routing: {
          destination: { platform: "local", conversationId },
          source: createLocalSource(conversationId),
        },
        delivery: {
          onAssistantMessage: () => {
            throw deliveryError;
          },
        },
        observers: {
          onStatus: ({ text }) => {
            observations.statuses.push(text);
          },
        },
      }),
    ).rejects.toBe(deliveryError);
    expect(observations.providerCalls).toBe(1);
    expect(observations.statuses).not.toContain("Checking details");
  });

  it("preserves explicit agent reasoning across handoff without routing", async () => {
    observations.requestedProfile = null;
    observations.routedReasoningLevel = "low";
    const conversationId = "local:test:model-handoff-explicit-reasoning";
    const outcome = await executeAgentRun({
      conversationId,
      turnId: "turn-model-handoff-explicit-reasoning",
      input: { messageText: "Implement the multi-file refactor." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
      },
      policy: { reasoningLevel: "xhigh" },
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.diagnostics.reasoningLevel).toBe("xhigh");
    expect(observations.reasoningLevels).toEqual(["xhigh", "xhigh"]);
  });

  it("keeps handoff independent from status observer failures", async () => {
    observations.requestedProfile = null;
    const conversationId = "local:test:model-handoff-status-failure";
    const outcome = await executeAgentRun({
      conversationId,
      turnId: "turn-model-handoff-status-failure",
      input: { messageText: "Implement the multi-file refactor." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
      },
      observers: {
        onStatus: () => {
          throw new Error("status unavailable");
        },
      },
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.diagnostics.modelId).toBe("openai/gpt-5.6-sol");
  });

  it("hands off to a selected named model profile", async () => {
    observations.requestedProfile = "coding";
    const conversationId = "local:test:named-model-handoff";
    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-named-model-handoff",
      turnId: "turn-named-model-handoff",
      input: { messageText: "Implement the focused code change." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
      },
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.diagnostics.modelId).toBe("openai/gpt-5.4");
    expect(observations.afterHandoffModelId).toBe("openai/gpt-5.4");
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("coding");
    expect(
      (await getConversationEventStore().loadHistory(conversationId))
        .map((event) => event.data)
        .filter((entry) => entry.type === "handoff"),
    ).toEqual([
      {
        type: "handoff",
        modelProfile: "coding",
        modelId: "openai/gpt-5.4",
        triggeringToolCallId: "handoff-call-1",
        replacementHistory: expectedHandoffReplacementHistory(),
      },
    ]);

    const followUp = await executeAgentRun({
      conversationId,
      runId: "run-named-model-handoff-follow-up",
      turnId: "turn-named-model-handoff-follow-up",
      input: { messageText: "Verify that change now." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
      },
    });
    expect(followUp.status).toBe("completed");
    if (followUp.status !== "completed") return;
    expect(followUp.result.diagnostics.modelId).toBe("openai/gpt-5.4");
    expect(observations.afterHandoffToolNames).not.toContain("handoff");
    expect(observations.summaryCalls).toBe(1);
  });

  it("blocks every call when handoff is mixed with a sibling tool", async () => {
    observations.mixedBatch = true;
    const conversationId = "local:test:mixed-model-handoff";
    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-mixed-handoff",
      turnId: "turn-mixed-handoff",
      input: { messageText: "Implement the change." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
      },
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.text).toBe("Standard model recovered safely.");
    expect(outcome.result.diagnostics.modelId).toBe(
      observations.initialModelId,
    );
    expect(observations.summaryCalls).toBe(0);
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("standard");
  });

  it("allows a durable conversation to hand off without a resumable turn record", async () => {
    const conversationId = "local:test:model-handoff-without-turn-record";
    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-model-handoff-without-turn-record",
      turnId: "turn-model-handoff-without-turn-record",
      input: { messageText: "Implement the refactor." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
      },
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.diagnostics.modelId).toBe("openai/gpt-5.6-sol");
    expect(observations.afterHandoffToolNames).not.toContain("handoff");
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("handoff");
    expect(
      (await getConversationEventStore().loadHistory(conversationId))
        .map((event) => event.data)
        .filter((entry) => entry.type === "handoff"),
    ).toEqual([
      {
        type: "handoff",
        modelProfile: "handoff",
        modelId: "openai/gpt-5.6-sol",
        triggeringToolCallId: "handoff-call-1",
        replacementHistory: expectedHandoffReplacementHistory(),
      },
    ]);
  });

  it("parks an immediate post-handoff yield on the replacement context", async () => {
    const conversationId = "local:test:model-handoff-yield";
    const sessionId = "turn-model-handoff-yield";
    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-model-handoff-yield",
      turnId: sessionId,
      input: { messageText: "Implement the risky refactor." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
      },
      durability: {
        shouldYield: () => true,
      },
    });

    expect(outcome.status).toBe("suspended");
    const record = await getAgentTurnSessionRecord(conversationId, sessionId);
    expect(record).toMatchObject({
      modelId: "openai/gpt-5.6-sol",
      state: "awaiting_resume",
    });
    expect(JSON.stringify(record?.piMessages)).toContain(
      "Implement the requested change and verify it.",
    );
    expect(JSON.stringify(record?.piMessages)).not.toContain(
      "Implement the risky refactor.",
    );
  });
});
