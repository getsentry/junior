import {
  executeAgentRun,
  observations,
  resetHandoffTestState,
  restoreHandoffTestState,
} from "./agent-run-model-handoff-fixture";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { loadConversationProjection } from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
import { ContextInputLimitExceededError } from "@/chat/services/context-compaction";

describe("model profile routing", () => {
  beforeEach(resetHandoffTestState);
  afterEach(restoreHandoffTestState);

  it("uses router-selected profile reasoning before the first provider request", async () => {
    observations.routedModelProfile = "handoff";
    observations.routedReasoningLevel = "xhigh";
    const conversationId = "local:test:router-model-handoff";
    const outcome = await executeAgentRun({
      instruction: {
        text: "Recommend the architecture and test strategy.",
        attachments: [
          {
            data: Buffer.from("architecture-diagram"),
            filename: "architecture.png",
            mediaType: "image/png",
          },
        ],
      },
      conversationId,
      runId: "run-router-model-handoff",
      turnId: "turn-router-model-handoff",
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
      reasoning: "xhigh",
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.text).toBe("Handoff model completed it.");
    expect(outcome.result.diagnostics.modelId).toBe("openai/gpt-5.6-sol");
    expect(observations.providerCalls).toBe(1);
    expect(observations.routerCalls).toBe(1);
    expect(observations.initialModelId).toBe("openai/gpt-5.6-sol");
    expect(observations.initialToolNames).toContain("handoff");
    expect(observations.initialImagePart).toEqual({
      type: "image",
      data: Buffer.from("architecture-diagram").toString("base64"),
      mimeType: "image/png",
    });
    expect(observations.reasoningLevels).toEqual(["high"]);
    expect(observations.summaryCalls).toBe(0);
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("standard");
    const events = (
      await getConversationEventStore().loadHistory(conversationId)
    ).map((event) => event.data);
    expect(events.filter((entry) => entry.type === "handoff")).toEqual([]);
    expect(events.filter((entry) => entry.type === "turn_routed")).toEqual([
      {
        type: "turn_routed",
        turnId: "turn-router-model-handoff",
        modelProfile: "handoff",
        modelId: "openai/gpt-5.6-sol",
        reasoningLevel: "high",
        confidence: 0.99,
        source: "router",
      },
    ]);
  });

  it("blocks oversized current input after a router handoff before the first provider request", async () => {
    observations.routedModelProfile = "handoff";
    const conversationId = "local:test:router-handoff-input-limit";
    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-router-handoff-input-limit",
      turnId: "turn-router-handoff-input-limit",
      instruction: { text: "x".repeat(1_600_000) },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.diagnostics.outcome).toBe("provider_error");
    expect(outcome.result.diagnostics.providerError).toBeInstanceOf(
      ContextInputLimitExceededError,
    );
    expect(observations.providerCalls).toBe(0);
  });

  it("does not compact context while applying a router-selected profile", async () => {
    observations.routedModelProfile = "handoff";
    observations.summaryPending = true;
    const conversationId = "local:test:router-model-handoff-timeout";
    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-router-model-handoff-timeout",
      turnId: "turn-router-model-handoff-timeout",
      instruction: { text: "Recommend the architecture." },
      deadlineAtMs: Date.now() + 1_000,
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
    });

    expect(outcome.status).toBe("completed");
    expect(observations.summaryCalls).toBe(0);
    expect(observations.summaryAborted).toBe(false);
    expect(observations.providerCalls).toBe(1);
  });

  it("does not hand off again when a routed model requests its active profile", async () => {
    observations.routedModelProfile = "handoff";
    observations.requestHandoffAfterRouting = true;
    const conversationId = "local:test:routed-model-confirms-handoff";
    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-routed-model-confirms-handoff",
      turnId: "turn-routed-model-confirms-handoff",
      instruction: { text: "Implement the multi-file refactor." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(observations.providerCalls).toBe(2);
    expect(observations.summaryCalls).toBe(0);
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("standard");
    expect(
      (await getConversationEventStore().loadHistory(conversationId))
        .map((event) => event.data)
        .filter((event) => event.type === "handoff"),
    ).toEqual([]);
  });

  it("can return a routed profile to default before another handoff", async () => {
    observations.routedModelProfile = "handoff";
    observations.requestedProfileSequence = ["standard", "coding"];
    const conversationId = "local:test:repeated-model-handoff";
    const handoffResults: Array<{ ok: boolean; result?: unknown }> = [];

    const outcome = await executeAgentRun({
      conversationId,
      runId: "run-repeated-model-handoff",
      turnId: "turn-repeated-model-handoff",
      instruction: { text: "Switch profiles as the work changes." },
      destination: { platform: "local", conversationId },
      source: createLocalSource(conversationId),
      onEvent: async (event) => {
        if (event.type === "tool_finished") {
          await ((result) => {
            if (result.toolName === "handoff") {
              handoffResults.push({
                ok: result.ok,
                ...(result.result !== undefined
                  ? { result: result.result }
                  : undefined),
              });
            }
          })(event.report);
          return;
        }
      },
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.result.diagnostics.modelId).toBe("openai/gpt-5.4");
    expect(observations.providerCalls).toBe(3);
    expect(observations.summaryCalls).toBe(2);
    expect(
      (await loadConversationProjection({ conversationId })).modelProfile,
    ).toBe("coding");
    expect(handoffResults).toEqual([
      {
        ok: true,
        result: {
          model_profile: "standard",
        },
      },
      {
        ok: true,
        result: {
          model_profile: "coding",
        },
      },
    ]);
  });
});
