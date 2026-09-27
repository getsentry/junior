import { describe, expect, it } from "vitest";
import {
  getAgentContextInputLimitTokens,
  getAgentContextCompactionTriggerTokens,
} from "@/chat/services/context-budget";
import { resolveGatewayModel } from "@/chat/pi/client";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { executeAgentRun } from "@/chat/agent";
import { botConfig } from "@/chat/config";
import { getDb } from "@/chat/db";
import { loadPendingMessageCards } from "@/chat/conversations/pending-cards";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { selfDiagnosticSchema } from "@/chat/self-diagnostic";
import { renderSlackCard } from "@/chat/slack/cards";
import { createModelStream } from "../fixtures/model-stream";

// This contract needs real tool wiring and persistence, not a model judge.
describe("self diagnostic", () => {
  it("returns the execution settings and saves a card without switching models", async () => {
    const conversationId = "local:test:self-diagnostic";
    const outcome = await executeAgentRun(
      {
        conversationId,
        turnId: "turn-self-diagnostic",
        runId: "run-self-diagnostic",
        instruction: { text: "Which model are you using?" },
        destination: { platform: "local", conversationId },
        source: createLocalSource(conversationId),
        disabledFeatures: ["handoff", "interactive-auth"],
        reasoning: "low",
      },
      createModelStream([
        { type: "toolCall", name: "self_diagnostic", arguments: {} },
        { type: "toolCall", name: "self_diagnostic", arguments: {} },
        { type: "text", text: "These are my current settings." },
      ]),
    );
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    const result = outcome.result.piMessages?.find(
      (message) =>
        message.role === "toolResult" && message.toolName === "self_diagnostic",
    );
    expect(result).toMatchObject({ isError: false });
    if (result?.role !== "toolResult") throw new Error("Missing diagnostic");
    const { observedAt, objectCards, ...facts } = result.details as Record<
      string,
      unknown
    >;
    const diagnostic = selfDiagnosticSchema.parse(facts);
    expect(diagnostic).toMatchObject({
      conversationId,
      turnId: "turn-self-diagnostic",
      runId: "run-self-diagnostic",
      supportsImageInput: expect.any(Boolean),
      active: {
        modelProfile: botConfig.defaultProfile,
        modelId: botConfig.profiles[botConfig.defaultProfile]!.modelId,
        reasoningLevel: "low",
      },
      defaultProfile: botConfig.defaultProfile,
      profiles: Object.entries(botConfig.profiles).map(([name, profile]) => ({
        modelProfile: name,
        modelId: profile.modelId,
        configuredReasoningLevel: profile.reasoningLevel ?? null,
        reasoningLevel: profile.reasoningLevel ?? "low",
        handoffAvailable: false,
      })),
    });
    const calls =
      outcome.result.piMessages?.filter(
        (message) => message.role === "assistant",
      ) ?? [];
    const first = calls[0]!;
    const next = calls[1]!;
    const estimatedTokens = first.usage.totalTokens;
    expect(estimatedTokens).toBeGreaterThan(0);
    expect(diagnostic.context).toEqual({
      scope: "active_history",
      source: "runtime_estimate",
      estimatedTokens,
      modelWindowTokens: resolveGatewayModel(diagnostic.active.modelId)
        .contextWindow,
      inputLimitTokens: getAgentContextInputLimitTokens(
        diagnostic.active.modelId,
      ),
      inputUtilizationPercent:
        (estimatedTokens /
          getAgentContextInputLimitTokens(diagnostic.active.modelId)) *
        100,
      remainingInputTokens:
        getAgentContextInputLimitTokens(diagnostic.active.modelId) -
        estimatedTokens,
      compactionTriggerTokens: getAgentContextCompactionTriggerTokens(
        diagnostic.active.modelId,
      ),
      aboveCompactionThreshold: false,
    });
    const expectedUsage = {
      inputTokens: first.usage.input,
      outputTokens: first.usage.output,
      cachedInputTokens: first.usage.cacheRead,
      cacheCreationTokens: first.usage.cacheWrite,
      totalTokens: first.usage.totalTokens,
      cost: first.usage.cost,
    };
    expect(diagnostic.usage).toEqual({
      scope: "completed_main_model_calls_in_current_slice",
      completedCalls: 1,
      totals: expectedUsage,
      lastCall: {
        modelId: diagnostic.active.modelId,
        completedAt: expect.any(String),
        usage: expectedUsage,
        cachedInputSharePercent:
          (first.usage.cacheRead /
            (first.usage.input +
              first.usage.cacheRead +
              first.usage.cacheWrite)) *
          100,
      },
    });
    const second = outcome.result.piMessages?.filter(
      (message) =>
        message.role === "toolResult" && message.toolName === "self_diagnostic",
    )[1];
    if (second?.role !== "toolResult")
      throw new Error("Missing second diagnostic");
    expect(second.details).toMatchObject({
      usage: {
        completedCalls: 2,
        totals: {
          inputTokens: first.usage.input + next.usage.input,
          cachedInputTokens: first.usage.cacheRead + next.usage.cacheRead,
          cacheCreationTokens: first.usage.cacheWrite + next.usage.cacheWrite,
          totalTokens: first.usage.totalTokens + next.usage.totalTokens,
        },
        lastCall: {
          cachedInputSharePercent:
            (next.usage.cacheRead /
              (next.usage.input +
                next.usage.cacheRead +
                next.usage.cacheWrite)) *
            100,
          usage: { cachedInputTokens: next.usage.cacheRead },
        },
      },
    });
    // Unreported reasoning stays unknown, not zero.
    expect(
      (second.details as { usage: { totals: object } }).usage.totals,
    ).not.toHaveProperty("reasoningTokens");
    expect(observedAt).toEqual(expect.any(String));
    const cards = await loadPendingMessageCards(conversationId);
    expect(cards).toEqual(expect.arrayContaining(objectCards as unknown[]));
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      kind: "object",
      displayType: "Self diagnostic",
      description: expect.stringContaining(diagnostic.active.modelId),
    });
    const annotations = await listConversationAnnotations(
      getDb(),
      conversationId,
    );
    expect(annotations).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      description: expect.stringContaining("cached share"),
    });
    expect(cards[0]).toMatchObject({
      description: expect.stringContaining(
        `Context estimate: ${estimatedTokens.toLocaleString("en-US")}`,
      ),
    });
    expect(renderSlackCard(cards[0]!, conversationId).text).toContain(
      diagnostic.active.modelId,
    );
  });
});
