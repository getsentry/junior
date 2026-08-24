import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import {
  isExperimentalFeatureEnabled,
  setExperimentalFeatures,
} from "@/chat/experimental";
import {
  registerLogRecordSink,
  type EmittedLogRecord,
} from "@/chat/logging";
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

  it("warns and ignores unknown experimental feature keys", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const records: EmittedLogRecord[] = [];
    const unregister = registerLogRecordSink((record) => records.push(record));

    try {
      await createApp({
        plugins: defineJuniorPlugins([]),
        experimental: {
          // @ts-expect-error intentional unknown key
          widgets: true,
          subagents: true,
        },
      });
    } finally {
      unregister();
    }

    expect(isExperimentalFeatureEnabled("subagents")).toBe(true);
    expect(records).toContainEqual(
      expect.objectContaining({
        eventName: "experimental.feature.unknown",
        level: "warn",
        attributes: expect.objectContaining({
          "app.experimental.feature": "widgets",
          "app.experimental.known_features": "passive-routing, subagents",
        }),
      }),
    );
  });
});
