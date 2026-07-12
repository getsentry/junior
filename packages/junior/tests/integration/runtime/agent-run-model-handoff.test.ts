import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";

const observations = vi.hoisted(() => ({
  afterHandoffModelId: "",
  afterHandoffToolNames: [] as string[],
  initialModelId: "",
  initialToolNames: [] as string[],
  mixedBatch: false,
  providerCalls: 0,
  requestedProfile: undefined as string | null | undefined,
  summaryCalls: 0,
  handoffStatusBeforeSummary: false,
  statuses: [] as string[],
  textDeltas: [] as string[],
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
        thinking_level: "high",
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
  createTracedStreamFn: () => async (model: any, context: any) => {
    observations.providerCalls += 1;
    const call = observations.providerCalls;
    if (call === 1) {
      observations.initialModelId = model.id;
      observations.initialToolNames = (context.tools ?? []).map(
        (tool: { name: string }) => tool.name,
      );
    } else {
      observations.afterHandoffModelId = model.id;
      observations.afterHandoffToolNames = (context.tools ?? []).map(
        (tool: { name: string }) => tool.name,
      );
    }

    const text =
      call === 1
        ? "The standard model started an answer that must be hidden."
        : observations.mixedBatch
          ? "Standard model recovered safely."
          : "Handoff model completed it.";
    const content: Array<Record<string, unknown>> = [{ type: "text", text }];
    if (call === 1) {
      content.push({
        type: "toolCall",
        id: "handoff-call-1",
        name: "handoff",
        arguments:
          observations.requestedProfile === undefined
            ? {}
            : { profile: observations.requestedProfile },
      });
      if (observations.mixedBatch) {
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
import { getAgentStepStore } from "@/chat/db";

const ORIGINAL_STATE_ADAPTER = process.env.JUNIOR_STATE_ADAPTER;

describe("executeAgentRun model handoff", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    observations.afterHandoffModelId = "";
    observations.afterHandoffToolNames = [];
    observations.initialModelId = "";
    observations.initialToolNames = [];
    observations.mixedBatch = false;
    observations.providerCalls = 0;
    observations.requestedProfile = undefined;
    observations.summaryCalls = 0;
    observations.handoffStatusBeforeSummary = false;
    observations.statuses = [];
    observations.textDeltas = [];
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
      input: { messageText: "Implement the multi-file refactor." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
        correlation: {
          conversationId,
          runId: "run-model-handoff",
          turnId: "turn-model-handoff",
        },
      },
      observers: {
        onStatus: ({ text }) => {
          observations.statuses.push(text);
        },
        onTextDelta: (text) => {
          observations.textDeltas.push(text);
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
    expect(observations.textDeltas).toEqual(["Handoff model completed it."]);
    expect(observations.initialModelId).not.toBe(
      observations.afterHandoffModelId,
    );
    expect(observations.afterHandoffModelId).toBe("openai/gpt-5.6-sol");
    expect(observations.afterHandoffToolNames).not.toContain("handoff");
    expect(observations.afterHandoffToolNames).toEqual(
      observations.initialToolNames.filter((name) => name !== "handoff"),
    );
    expect(observations.summaryCalls).toBe(1);
    expect(observations.handoffStatusBeforeSummary).toBe(true);
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("handoff");
    const epochMarkers = (await getAgentStepStore().loadHistory(conversationId))
      .map((step) => step.entry)
      .filter((entry) => entry.type === "context_epoch_started");
    expect(epochMarkers).toEqual([
      {
        type: "context_epoch_started",
        reason: "initial",
        modelProfile: "standard",
        modelId: observations.initialModelId,
      },
      {
        type: "context_epoch_started",
        reason: "handoff",
        modelProfile: "handoff",
        modelId: "openai/gpt-5.6-sol",
      },
    ]);
    const projection = await loadProjection({ conversationId });
    expect(projection).toHaveLength(1);
    expect(JSON.stringify(projection)).toContain(
      "Implement the requested change and verify it.",
    );
    expect(outcome.result.piMessages?.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(outcome.result.piMessages)).toContain(
      "<runtime-turn-context>",
    );

    const followUp = await executeAgentRun({
      input: { messageText: "Now explain the verification result." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
        correlation: {
          conversationId,
          runId: "run-model-handoff-follow-up",
          turnId: "turn-model-handoff-follow-up",
        },
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

  it("keeps handoff independent from status observer failures", async () => {
    observations.requestedProfile = null;
    const conversationId = "local:test:model-handoff-status-failure";
    const outcome = await executeAgentRun({
      input: { messageText: "Implement the multi-file refactor." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
        correlation: {
          conversationId,
          turnId: "turn-model-handoff-status-failure",
        },
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
      input: { messageText: "Implement the focused code change." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
        correlation: {
          conversationId,
          runId: "run-named-model-handoff",
          turnId: "turn-named-model-handoff",
        },
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
      (await getAgentStepStore().loadHistory(conversationId))
        .map((step) => step.entry)
        .filter((entry) => entry.type === "context_epoch_started"),
    ).toEqual([
      {
        type: "context_epoch_started",
        reason: "initial",
        modelProfile: "standard",
        modelId: observations.initialModelId,
      },
      {
        type: "context_epoch_started",
        reason: "handoff",
        modelProfile: "coding",
        modelId: "openai/gpt-5.4",
      },
    ]);

    const followUp = await executeAgentRun({
      input: { messageText: "Verify that change now." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
        correlation: {
          conversationId,
          runId: "run-named-model-handoff-follow-up",
          turnId: "turn-named-model-handoff-follow-up",
        },
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
      input: { messageText: "Implement the change." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
        correlation: {
          conversationId,
          runId: "run-mixed-handoff",
          turnId: "turn-mixed-handoff",
        },
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
      input: { messageText: "Implement the refactor." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
        correlation: {
          conversationId,
          runId: "run-model-handoff-without-turn-record",
        },
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
      (await getAgentStepStore().loadHistory(conversationId))
        .map((step) => step.entry)
        .filter((entry) => entry.type === "context_epoch_started"),
    ).toEqual([
      {
        type: "context_epoch_started",
        reason: "initial",
        modelProfile: "standard",
        modelId: observations.initialModelId,
      },
      {
        type: "context_epoch_started",
        reason: "handoff",
        modelProfile: "handoff",
        modelId: "openai/gpt-5.6-sol",
      },
    ]);
  });

  it("parks an immediate post-handoff yield on the replacement context", async () => {
    const conversationId = "local:test:model-handoff-yield";
    const sessionId = "turn-model-handoff-yield";
    const outcome = await executeAgentRun({
      input: { messageText: "Implement the risky refactor." },
      routing: {
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
        correlation: {
          conversationId,
          runId: "run-model-handoff-yield",
          turnId: sessionId,
        },
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
