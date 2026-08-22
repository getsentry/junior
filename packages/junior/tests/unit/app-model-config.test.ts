import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { botConfig, restoreModelProfiles } from "@/chat/config";

const originalModelProfiles = botConfig.profiles;

afterEach(() => {
  restoreModelProfiles(originalModelProfiles);
});

describe("createApp model config", () => {
  it("configures named handoff profiles", async () => {
    await createApp({
      models: {
        profiles: {
          "gpt-5": "openai/gpt-5.6-sol",
          "opus-5": "anthropic/claude-opus-5",
        },
      },
      plugins: defineJuniorPlugins([]),
    });

    expect(botConfig.profiles).toMatchObject({
      "gpt-5": { modelId: "openai/gpt-5.6-sol" },
      "opus-5": { modelId: "anthropic/claude-opus-5" },
    });
  });

  it("rejects reserved profile names", async () => {
    await expect(
      createApp({
        models: { profiles: { handoff: "openai/gpt-5.6-sol" } },
        plugins: defineJuniorPlugins([]),
      }),
    ).rejects.toThrow('models.profiles profile "handoff" is reserved');
  });
});
