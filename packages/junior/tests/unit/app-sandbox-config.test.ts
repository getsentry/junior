import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import {
  isExperimentalFeatureEnabled,
  setExperimentalFeatures,
} from "@/chat/experimental";
import {
  getSandboxResources,
  setSandboxResourceConfig,
} from "@/chat/sandbox/resources";

afterEach(() => {
  setSandboxResourceConfig(undefined);
  setExperimentalFeatures(undefined);
});

describe("createApp sandbox config", () => {
  it("configures sandbox vCPUs", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
      sandbox: { vcpus: 4 },
    });

    expect(getSandboxResources()).toEqual({ vcpus: 4 });
  });

  it("rejects invalid sandbox vCPUs", async () => {
    await expect(
      createApp({
        plugins: defineJuniorPlugins([]),
        sandbox: { vcpus: 0 },
      }),
    ).rejects.toThrow("sandbox.vcpus must be a positive integer");
  });
});

describe("createApp experimental config", () => {
  it("opts into experimental subagents", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
      experimental: { subagents: true },
    });

    expect(isExperimentalFeatureEnabled("subagents")).toBe(true);
  });

  it("rejects unknown experimental feature keys", async () => {
    await expect(
      createApp({
        plugins: defineJuniorPlugins([]),
        experimental: {
          // @ts-expect-error intentional unknown key
          widgets: true,
        },
      }),
    ).rejects.toThrow(
      "experimental.widgets is not a known experimental feature",
    );
  });
});
