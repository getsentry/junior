import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isExperimentalFeatureEnabled,
  setExperimentalFeatures,
} from "@/chat/experimental";
import {
  registerLogRecordSink,
  type EmittedLogRecord,
} from "@/chat/logging";

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

  it("warns and ignores unknown experimental feature keys from app config", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const records: EmittedLogRecord[] = [];
    const unregister = registerLogRecordSink((record) => records.push(record));

    try {
      setExperimentalFeatures({
        // @ts-expect-error intentional unknown key
        widgets: true,
        subagents: true,
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
