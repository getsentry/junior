import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { botConfig, getSlackReactionConfig } from "@/chat/config";

const originalBotConfig = { ...botConfig };

afterEach(() => {
  Object.assign(botConfig, originalBotConfig);
});

describe("createApp model config", () => {
  it("configures all host model ids from createApp options", async () => {
    await createApp({
      embeddingModelId: "openai/text-embedding-3-large",
      fastModelId: "anthropic/claude-haiku-4.5",
      guardianModelId: "openai/gpt-6-luna",
      imageGenerationModelId: "google/gemini-3-pro-image",
      modelId: "anthropic/claude-sonnet-5",
      rerankingModelId: "voyage/rerank-2.5",
      visionModelId: "openai/gpt-5.6-sol",
      webSearchModelId: "openai/gpt-5.4",
      plugins: defineJuniorPlugins([]),
    });

    expect(botConfig).toMatchObject({
      embeddingModelId: "openai/text-embedding-3-large",
      fastModelId: "anthropic/claude-haiku-4.5",
      guardianModelId: "openai/gpt-6-luna",
      imageGenerationModelId: "google/gemini-3-pro-image",
      modelId: "anthropic/claude-sonnet-5",
      rerankingModelId: "voyage/rerank-2.5",
      visionModelId: "openai/gpt-5.6-sol",
      webSearchModelId: "openai/gpt-5.4",
    });
  });

  it("restores model config when an override is invalid", async () => {
    await expect(
      createApp({
        embeddingModelId: "openai/text-embedding-3-large",
        fastModelId: " ",
        plugins: defineJuniorPlugins([]),
      }),
    ).rejects.toThrow("fastModelId must not be empty");

    expect(botConfig.embeddingModelId).toBe(originalBotConfig.embeddingModelId);
    expect(botConfig.fastModelId).toBe(originalBotConfig.fastModelId);
  });

  it("starts each app from the defaults instead of an earlier app's options", async () => {
    await createApp({
      modelId: "openai/gpt-5.6-sol",
      fastModelId: "anthropic/claude-haiku-4.5",
      limits: {
        contextWindowTokens: 2_000,
        eventAutomationRunLimit: { maxRuns: 2, windowMs: 60 * 60 * 1000 },
        maxToolCallsPerTurn: 3,
      },
      slack: {
        completedReactionEmoji: "jr-done",
      },
      plugins: defineJuniorPlugins([]),
    });
    expect(botConfig).toMatchObject({
      contextWindowTokens: 2_000,
      modelId: "openai/gpt-5.6-sol",
      eventAutomationRunWindowMs: 60 * 60 * 1000,
      maxEventAutomationRuns: 2,
      maxToolCallsPerTurn: 3,
    });

    await createApp({ plugins: defineJuniorPlugins([]) });

    expect(botConfig).toMatchObject({
      contextWindowTokens: originalBotConfig.contextWindowTokens,
      modelId: originalBotConfig.modelId,
      fastModelId: originalBotConfig.fastModelId,
      eventAutomationRunWindowMs: originalBotConfig.eventAutomationRunWindowMs,
      maxEventAutomationRuns: originalBotConfig.maxEventAutomationRuns,
      maxToolCallsPerTurn: originalBotConfig.maxToolCallsPerTurn,
    });
    expect(getSlackReactionConfig().completedReactionEmoji).toBe(
      "white_check_mark",
    );
  });
});
