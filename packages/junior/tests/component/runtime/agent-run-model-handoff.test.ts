import {
  executeAgentRun,
  observations,
  resetHandoffTestState,
  restoreHandoffTestState,
} from "./agent-run-model-handoff-fixture";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import type { AgentRun } from "@/chat/agent/types";
import { RetryableDeliveryError } from "@/chat/agent/types";
import { getPausedTurnRequest } from "@/chat/task-execution/turn-wake";
import {
  loadConversationProjection,
  loadProjection,
  recordTurnRoute,
} from "@/chat/conversations/projection";
import { getTurnRecord } from "@/chat/task-execution/turn-cursor";
import { getConversationEventStore } from "@/chat/db";
import { ContextInputLimitExceededError } from "@/chat/services/context-compaction";

function expectedHandoffReplacementHistory() {
  return [
    {
      item: {
        type: "user_message",
        timestamp: expect.any(Number),
        content: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining(
              "<current-instruction>\nModel handoff checkpoint.",
            ),
          }),
        ],
        provenance: { authority: "context" },
      },
    },
  ];
}

describe("model handoff execution", () => {
  beforeEach(resetHandoffTestState);
  afterEach(restoreHandoffTestState);

  it("compacts and upgrades the same conversation before continuing the turn", async () => {
    observations.requestedProfile = "handoff";
    const conversationId = "local:test:model-handoff";
    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-model-handoff",
      turnId: "turn-model-handoff",
      instruction: { text: "Implement the multi-file refactor." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
      onEvent: async (event) => {
        if (event.type === "status") {
          await (({ text }) => {
            observations.statuses.push(text);
          })({ text: event.text });
          return;
        }
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
    expect(observations.afterHandoffToolNames).toContain("handoff");
    expect(observations.afterHandoffToolNames).toEqual(
      observations.initialToolNames,
    );
    expect(observations.initialHandoffProfiles).toEqual(["coding", "handoff"]);
    expect(observations.afterHandoffProfiles).toEqual(["standard", "coding"]);
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
        reasoningLevel: "high",
        triggeringToolCallId: "handoff-call-1",
        summary: "Implement the requested change and verify it.",
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
      "user",
      "assistant",
    ]);
    expect(observations.afterHandoffMessages).toHaveLength(2);
    expect(observations.afterHandoffMessages[0]?.role).toBe("user");
    expect(observations.afterHandoffMessages[0]?.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("<runtime-turn-context>"),
      }),
    ]);
    expect(observations.afterHandoffMessages[1]?.role).toBe("user");
    expect(observations.afterHandoffMessages[1]?.content).toEqual([
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
      instruction: { text: "Now explain the verification result." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
    });
    expect(followUp.status).toBe("completed");
    if (followUp.status !== "completed") return;
    expect(followUp.result.diagnostics.modelId).toBe("openai/gpt-5.6-sol");
    expect(observations.providerCalls).toBe(3);
    expect(observations.routerCalls).toBe(1);
    expect(
      (await getConversationEventStore().loadHistory(conversationId))
        .map((event) => event.data)
        .find(
          (event) =>
            event.type === "turn_routed" &&
            event.turnId === "turn-model-handoff-follow-up",
        ),
    ).toEqual({
      type: "turn_routed",
      turnId: "turn-model-handoff-follow-up",
      modelProfile: "handoff",
      modelId: "openai/gpt-5.6-sol",
      reasoningLevel: "high",
      source: "inherited",
    });
    expect(observations.afterHandoffModelId).toBe("openai/gpt-5.6-sol");
    expect(observations.afterHandoffToolNames).toContain("handoff");
    expect(observations.reasoningLevels).toEqual(["high", "high", "high"]);
    expect(observations.summaryCalls).toBe(1);
  });

  it("blocks oversized steering after a tool handoff before the next provider request", async () => {
    observations.requestedProfile = "handoff";
    const conversationId = "local:test:tool-handoff-input-limit";
    let drained = false;
    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-tool-handoff-input-limit",
      turnId: "turn-tool-handoff-input-limit",
      instruction: { text: "Start the implementation." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
      durability: {
        drainSteeringMessages: async (inject) => {
          if (drained) {
            return [];
          }
          drained = true;
          const messages = [
            {
              text: "y".repeat(1_600_000),
              timestampMs: 2_000,
              provenance: { authority: "instruction" as const },
            },
          ];
          await inject(messages);
          return messages;
        },
      },
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.diagnostics.outcome).toBe("provider_error");
    expect(outcome.result.diagnostics.providerError).toBeInstanceOf(
      ContextInputLimitExceededError,
    );
    expect(observations.providerCalls).toBe(1);
  });

  it("delivers only the tool-free assistant message after tool use", async () => {
    observations.progressTool = true;
    const delivered: AssistantMessage[] = [];
    const conversationId = "local:test:assistant-message-delivery";

    const outcome = await executeAgentRun({
      conversationId,
      turnId: "turn-assistant-message-delivery",
      instruction: { text: "Check the details." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
      delivery: (message) => void delivered.push(message),
    });

    expect(outcome.status).toBe("completed");
    const [reply] = delivered;
    expect(getAssistantReplyText(reply!)).toBe("Handoff model completed it.");
    expect(reply).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
  });

  it("executes tools before a terminal assistant delivery failure", async () => {
    observations.progressTool = true;
    const deliveryError = new Error("destination unavailable");
    const conversationId = "local:test:assistant-message-delivery-failure";

    await expect(
      executeAgentRun({
        conversationId,
        turnId: "turn-assistant-message-delivery-failure",
        instruction: { text: "Check the details." },
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
        delivery: () => {
          throw deliveryError;
        },
        onEvent: async (event) => {
          if (event.type === "status") {
            await (({ text }) => {
              observations.statuses.push(text);
            })({ text: event.text });
            return;
          }
        },
      }),
    ).rejects.toBe(deliveryError);
    expect(observations.providerCalls).toBe(2);
    expect(observations.statuses).toContain("Checking details");
  });

  it("resumes from the last safe boundary after a retryable delivery failure", async () => {
    observations.progressTool = true;
    const conversationId = "local:test:assistant-message-delivery-retry";
    const turnId = "turn-assistant-message-delivery-retry";
    const delivered: Array<{ text: string }> = [];
    let deliveryAttempts = 0;
    const request: AgentRun = {
      conversationId,
      turnId,
      instruction: { text: "Check the details." },
      destination: { platform: "local" as const, conversationId },
      source: createLocalSource(conversationId),
      delivery: (message) => {
        deliveryAttempts += 1;
        if (deliveryAttempts === 1) {
          throw new RetryableDeliveryError(new Error("Slack unavailable"));
        }
        const text = getAssistantReplyText(message);
        if (text) delivered.push({ text });
      },
    };

    const suspended = await executeAgentRun(request);

    expect(suspended).toMatchObject({
      status: "suspended",
      reason: "retry",
      resumeVersion: expect.any(Number),
    });
    const suspendedRecord = await getTurnRecord(conversationId, turnId);
    expect(suspendedRecord).toMatchObject({
      state: "paused",
      resumeReason: "retry",
      sliceId: 2,
    });
    expect(JSON.stringify(suspendedRecord?.piMessages)).not.toContain(
      "Handoff model completed it.",
    );
    await expect(
      getPausedTurnRequest({ conversationId, turnId: turnId }),
    ).resolves.toMatchObject({
      conversationId,
      turnId: turnId,
      expectedVersion: suspendedRecord?.version,
    });

    const completed = await executeAgentRun(request);

    expect(completed.status).toBe("completed");
    expect(delivered).toEqual([{ text: "Handoff model completed it." }]);
    expect(deliveryAttempts).toBe(2);
    expect(observations.providerCalls).toBe(3);
  });

  it("lets a handoff profile override default-model reasoning", async () => {
    observations.requestedProfile = "handoff";
    observations.routedReasoningLevel = "low";
    const conversationId = "local:test:model-handoff-explicit-reasoning";
    const outcome = await executeAgentRun({
      conversationId,
      turnId: "turn-model-handoff-explicit-reasoning",
      instruction: { text: "Implement the multi-file refactor." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
      reasoning: "xhigh",
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.diagnostics.reasoningLevel).toBe("high");
    expect(observations.providerCalls).toBe(2);
    expect(observations.reasoningLevels).toEqual(["xhigh", "high"]);

    const followUp = await executeAgentRun({
      conversationId,
      turnId: "turn-model-handoff-explicit-reasoning-follow-up",
      instruction: { text: "Now verify the result." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
      reasoning: "xhigh",
    });

    expect(followUp.status).toBe("completed");
    if (followUp.status !== "completed") return;
    expect(followUp.result.diagnostics.reasoningLevel).toBe("high");
    expect(observations.providerCalls).toBe(3);
    expect(observations.reasoningLevels).toEqual(["xhigh", "high", "high"]);
  });

  it("keeps handoff independent from status observer failures", async () => {
    observations.requestedProfile = "handoff";
    const conversationId = "local:test:model-handoff-status-failure";
    const outcome = await executeAgentRun({
      conversationId,
      turnId: "turn-model-handoff-status-failure",
      instruction: { text: "Implement the multi-file refactor." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
      onEvent: async (event) => {
        if (event.type === "status") {
          throw new Error("status unavailable");
        }
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
      instruction: { text: "Implement the focused code change." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
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
        reasoningLevel: "high",
        triggeringToolCallId: "handoff-call-1",
        summary: "Implement the requested change and verify it.",
        replacementHistory: expectedHandoffReplacementHistory(),
      },
    ]);

    const followUp = await executeAgentRun({
      conversationId,
      runId: "run-named-model-handoff-follow-up",
      turnId: "turn-named-model-handoff-follow-up",
      instruction: { text: "Verify that change now." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
    });
    expect(followUp.status).toBe("completed");
    if (followUp.status !== "completed") return;
    expect(followUp.result.diagnostics.modelId).toBe("openai/gpt-5.4");
    expect(observations.routerCalls).toBe(1);
    expect(observations.afterHandoffToolNames).toContain("handoff");
    expect(observations.summaryCalls).toBe(1);
  });

  it("blocks every call when handoff is mixed with a sibling tool", async () => {
    observations.mixedBatch = true;
    const conversationId = "local:test:mixed-model-handoff";
    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-mixed-handoff",
      turnId: "turn-mixed-handoff",
      instruction: { text: "Implement the change." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
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
      instruction: { text: "Implement the refactor." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.diagnostics.modelId).toBe("openai/gpt-5.6-sol");
    expect(observations.afterHandoffToolNames).toContain("handoff");
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
        reasoningLevel: "high",
        triggeringToolCallId: "handoff-call-1",
        summary: "Implement the requested change and verify it.",
        replacementHistory: expectedHandoffReplacementHistory(),
      },
    ]);
  });

  it("resumes a stored non-default route without a handoff", async () => {
    observations.requestedProfile = null;
    const conversationId = "local:test:model-route-resume";
    const turnId = "turn-model-route-resume";
    await recordTurnRoute({
      conversationId,
      turnId,
      modelProfile: "coding",
      modelId: "openai/gpt-5.4",
      reasoningLevel: "high",
      source: "router",
    });

    const resumed = await executeAgentRun({
      conversationId,
      runId: "run-model-route-resume",
      turnId,
      instruction: { text: "Continue the refactor." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
    });

    expect(resumed.status).toBe("completed");
    if (resumed.status !== "completed") return;
    expect(resumed.result.diagnostics.modelId).toBe("openai/gpt-5.4");
    expect(observations.initialModelId).toBe("openai/gpt-5.4");
    expect(observations.routerCalls).toBe(0);
  });

  it("resumes a stored route after handoff to the default profile", async () => {
    observations.requestedProfile = null;
    const conversationId = "local:test:model-handoff-default-resume";
    const turnId = "turn-model-handoff-default-resume";
    await recordTurnRoute({
      conversationId,
      turnId,
      modelProfile: "coding",
      modelId: "openai/gpt-5.4",
      reasoningLevel: "high",
      source: "router",
    });
    await getConversationEventStore().replaceHistory(conversationId, {
      createdAtMs: Date.now(),
      data: {
        type: "handoff",
        modelProfile: "standard",
        modelId: "xai/grok-4.5",
        reasoningLevel: "high",
        triggeringToolCallId: "handoff-call-default",
        replacementHistory: [],
      },
    });
    await getConversationEventStore().replaceHistory(conversationId, {
      createdAtMs: Date.now(),
      data: {
        type: "compaction",
        modelProfile: "standard",
        modelId: "xai/grok-4.5",
        replacementHistory: [],
      },
    });

    const resumed = await executeAgentRun({
      conversationId,
      runId: "run-model-handoff-default-resume",
      turnId,
      instruction: { text: "Implement the risky refactor." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
    });

    expect(resumed.status).toBe("completed");
    if (resumed.status !== "completed") return;
    expect(resumed.result.diagnostics.modelId).toBe("xai/grok-4.5");
    expect(observations.initialModelId).toBe("xai/grok-4.5");
    expect(observations.routerCalls).toBe(0);
  });
});
