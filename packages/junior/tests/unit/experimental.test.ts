import { afterEach, describe, expect, it } from "vitest";
import {
  isExperimentalFeatureEnabled,
  setExperimentalFeatures,
} from "@/chat/experimental";

afterEach(() => {
  setExperimentalFeatures(undefined);
});

describe("experimental features", () => {
  it("defaults experimental features off", () => {
    setExperimentalFeatures(undefined);
    expect(isExperimentalFeatureEnabled("passive-routing")).toBe(false);
    expect(isExperimentalFeatureEnabled("subagents")).toBe(false);
  });

  it("enables features from createApp-style config", () => {
    setExperimentalFeatures({ "passive-routing": true, subagents: true });
    expect(isExperimentalFeatureEnabled("passive-routing")).toBe(true);
    expect(isExperimentalFeatureEnabled("subagents")).toBe(true);
  });

  it("treats explicit false as disabled", () => {
    setExperimentalFeatures({ "passive-routing": false, subagents: false });
    expect(isExperimentalFeatureEnabled("passive-routing")).toBe(false);
    expect(isExperimentalFeatureEnabled("subagents")).toBe(false);
  });

  it("rejects unknown experimental feature keys from app config", () => {
    expect(() =>
      setExperimentalFeatures({
        // @ts-expect-error intentional unknown key
        widgets: true,
      }),
    ).toThrow("experimental.widgets is not a known experimental feature");
  });
});
