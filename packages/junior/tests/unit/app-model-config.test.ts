import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { botConfig } from "@/chat/config";

const originalDefaultProfile = botConfig.defaultProfile;
const originalProfiles = botConfig.profiles;

afterEach(() => {
  botConfig.defaultProfile = originalDefaultProfile;
  botConfig.profiles = originalProfiles;
});

describe("createApp profiles", () => {
  it("configures named profiles and declares the default", async () => {
    await createApp({
      defaultProfile: "gpt-5",
      profiles: {
        standard: "xai/grok-4.5",
        handoff: "openai/gpt-5.6-sol",
        "gpt-5": "openai/gpt-5.6-sol",
        "opus-5": "anthropic/claude-opus-5",
      },
      plugins: defineJuniorPlugins([]),
    });

    expect(botConfig.defaultProfile).toBe("gpt-5");
    expect(botConfig.profiles).toMatchObject({
      standard: { modelId: "xai/grok-4.5" },
      handoff: { modelId: "openai/gpt-5.6-sol" },
      "gpt-5": { modelId: "openai/gpt-5.6-sol" },
      "opus-5": { modelId: "anthropic/claude-opus-5" },
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
    ).rejects.toThrow("defaultProfile is required");
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
