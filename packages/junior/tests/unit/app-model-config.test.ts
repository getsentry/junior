import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { botConfig } from "@/chat/config";

const originalProfiles = botConfig.profiles;

afterEach(() => {
  botConfig.profiles = originalProfiles;
});

describe("createApp profiles", () => {
  it("configures named profiles including standard and handoff", async () => {
    await createApp({
      profiles: {
        standard: "xai/grok-4.5",
        handoff: "openai/gpt-5.6-sol",
        "gpt-5": "openai/gpt-5.6-sol",
        "opus-5": "anthropic/claude-opus-5",
      },
      plugins: defineJuniorPlugins([]),
    });

    expect(botConfig.profiles).toMatchObject({
      standard: { modelId: "xai/grok-4.5" },
      handoff: { modelId: "openai/gpt-5.6-sol", reasoningLevel: "high" },
      "gpt-5": { modelId: "openai/gpt-5.6-sol" },
      "opus-5": { modelId: "anthropic/claude-opus-5" },
    });
  });

  it("rejects invalid profile names", async () => {
    await expect(
      createApp({
        profiles: { Coding: "openai/gpt-5.6-sol" },
        plugins: defineJuniorPlugins([]),
      }),
    ).rejects.toThrow('profiles profile "Coding" must match');
  });
});
