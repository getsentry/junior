import { describe, expect, it } from "vitest";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import { useConfig } from "../fixtures/config";

describe("experimental features", () => {
  it("defaults experimental features off", () => {
    useConfig({ experimental: undefined });
    expect(isExperimentalFeatureEnabled("passive-routing")).toBe(false);
  });

  it("enables features from createApp-style config", () => {
    useConfig({ experimental: { "passive-routing": true } });
    expect(isExperimentalFeatureEnabled("passive-routing")).toBe(true);
  });

  it("treats explicit false as disabled", () => {
    useConfig({ experimental: { "passive-routing": false } });
    expect(isExperimentalFeatureEnabled("passive-routing")).toBe(false);
  });

  it("rejects unknown experimental feature keys from app config", () => {
    expect(() =>
      useConfig({
        experimental: {
          widgets: true,
        },
      }),
    ).toThrow("experimental.widgets is not a known experimental feature");
  });
});
