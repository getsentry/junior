import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { botConfig } from "@/chat/config";

const originalBotConfig = { ...botConfig };

afterEach(() => {
  Object.assign(botConfig, originalBotConfig);
});

describe("createApp profiles", () => {
  it("configures all host model ids from createApp options", async () => {
    await createApp({
      defaultProfile: "standard",
      embeddingModelId: "openai/text-embedding-3-large",
      fastModelId: "anthropic/claude-haiku-4.5",
      guardianModelId: "openai/gpt-5.6-luna",
      imageGenerationModelId: "google/gemini-3-pro-image",
      profiles: {
        standard: "anthropic/claude-sonnet-5",
        handoff: "openai/gpt-5.6-sol",
      },
      visionModelId: "openai/gpt-5.6-sol",
      webSearchModelId: "openai/gpt-5.4",
      plugins: defineJuniorPlugins([]),
    });

    expect(botConfig).toMatchObject({
      defaultProfile: "standard",
      embeddingModelId: "openai/text-embedding-3-large",
      fastModelId: "anthropic/claude-haiku-4.5",
      guardianModelId: "openai/gpt-5.6-luna",
      imageGenerationModelId: "google/gemini-3-pro-image",
      profiles: {
        standard: { modelId: "anthropic/claude-sonnet-5" },
        handoff: { modelId: "openai/gpt-5.6-sol" },
      },
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

  it("configures named profiles and declares the default", async () => {
    await createApp({
      defaultProfile: "gpt-5",
      profiles: {
        "gpt-5": "openai/gpt-5.6-sol",
        "opus-5": "anthropic/claude-opus-5",
      },
      plugins: defineJuniorPlugins([]),
    });

    expect(botConfig.defaultProfile).toBe("gpt-5");
    expect(botConfig.profiles).toEqual({
      "gpt-5": { modelId: "openai/gpt-5.6-sol" },
      "opus-5": { modelId: "anthropic/claude-opus-5" },
    });
  });

  it("accepts profile objects with description and reasoning settings", async () => {
    await createApp({
      defaultProfile: "standard",
      profiles: {
        standard: {
          modelId: "xai/grok-4.5",
          description: "Default general assistant work.",
        },
        coding: {
          modelId: "openai/gpt-5.6-sol",
          description: "Use for implementation and debugging.",
          reasoningLevel: "high",
        },
      },
      plugins: defineJuniorPlugins([]),
    });

    expect(botConfig.defaultProfile).toBe("standard");
    expect(botConfig.profiles).toEqual({
      standard: {
        modelId: "xai/grok-4.5",
        description: "Default general assistant work.",
      },
      coding: {
        modelId: "openai/gpt-5.6-sol",
        description: "Use for implementation and debugging.",
        reasoningLevel: "high",
      },
    });
  });

  it("rejects a default profile that is not configured", async () => {
    await expect(
      createApp({
        defaultProfile: "missing",
        profiles: { coding: "openai/gpt-5.6-sol" },
        plugins: defineJuniorPlugins([]),
      }),
    ).rejects.toThrow('defaultProfile "missing" is not configured');
  });

  it("requires a declared default with app profiles", async () => {
    await expect(
      createApp({
        profiles: { coding: "openai/gpt-5.6-sol" },
        plugins: defineJuniorPlugins([]),
      }),
    ).rejects.toThrow(
      "profiles and defaultProfile must be configured together",
    );
  });

  it("requires profiles with a declared default", async () => {
    await expect(
      createApp({
        defaultProfile: "coding",
        plugins: defineJuniorPlugins([]),
      }),
    ).rejects.toThrow(
      "profiles and defaultProfile must be configured together",
    );
  });

  it("rejects invalid profile names", async () => {
    await expect(
      createApp({
        defaultProfile: "Coding",
        profiles: { Coding: "openai/gpt-5.6-sol" },
        plugins: defineJuniorPlugins([]),
      }),
    ).rejects.toThrow('profiles profile "Coding" must match');
  });
});
