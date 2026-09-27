import { describe, expect, it } from "vitest";
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
    expect(diagnostic).toEqual({
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
    expect(observedAt).toEqual(expect.any(String));
    const cards = await loadPendingMessageCards(conversationId);
    expect(cards).toEqual(objectCards);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "object",
      displayType: "Self diagnostic",
      description: expect.stringContaining(diagnostic.active.modelId),
    });
    const annotations = await listConversationAnnotations(
      getDb(),
      conversationId,
    );
    expect(annotations).toHaveLength(1);
    expect(renderSlackCard(cards[0]!, conversationId).text).toContain(
      diagnostic.active.modelId,
    );
  });
});
