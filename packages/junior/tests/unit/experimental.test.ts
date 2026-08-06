import { afterEach, describe, expect, it } from "vitest";
import {
  isExperimentalFeatureEnabled,
  parseExperimentalFeaturesEnv,
  setExperimentalFeatures,
} from "@/chat/experimental";

afterEach(() => {
  setExperimentalFeatures(undefined);
  delete process.env.JUNIOR_EXPERIMENTAL;
});

describe("experimental features", () => {
  it("defaults experimental features off", () => {
    expect(isExperimentalFeatureEnabled("subagents")).toBe(false);
  });

  it("enables features from JUNIOR_EXPERIMENTAL", () => {
    process.env.JUNIOR_EXPERIMENTAL = "subagents";
    expect(isExperimentalFeatureEnabled("subagents")).toBe(true);
  });

  it("lets createApp-style config override the env list", () => {
    process.env.JUNIOR_EXPERIMENTAL = "subagents";
    setExperimentalFeatures({ subagents: false });
    expect(isExperimentalFeatureEnabled("subagents")).toBe(false);
  });

  it("rejects unknown experimental feature names from env", () => {
    expect(() => parseExperimentalFeaturesEnv("subagents,not-a-thing")).toThrow(
      'JUNIOR_EXPERIMENTAL contains unknown feature "not-a-thing"',
    );
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
