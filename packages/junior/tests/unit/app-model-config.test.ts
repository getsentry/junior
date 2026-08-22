import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { botConfig } from "@/chat/config";

const originalProfiles = botConfig.profiles;

afterEach(() => {
  botConfig.profiles = originalProfiles;
});

describe("createApp profiles", () => {
  it("configures named handoff profiles", async () => {
    await createApp({
      profiles: {
        "gpt-5": "openai/gpt-5.6-sol",
        "opus-5": "anthropic/claude-opus-5",
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
        profiles: { handoff: "openai/gpt-5.6-sol" },
        plugins: defineJuniorPlugins([]),
      }),
    ).rejects.toThrow('profiles profile "handoff" is reserved');
  });
});
