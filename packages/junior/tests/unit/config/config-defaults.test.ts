import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/chat/plugins/registry", () => ({
  isPluginConfigKey: (key: string) =>
    ["sentry.org", "sentry.project", "github.org", "github.repo"].includes(key),
}));

import {
  getConfigDefaults,
  setConfigDefaults,
} from "@/chat/configuration/defaults";

afterEach(() => {
  setConfigDefaults(undefined);
});

describe("install config defaults", () => {
  it("returns an empty object when no defaults are set", () => {
    expect(getConfigDefaults()).toEqual({});
  });

  it("stores and retrieves defaults", () => {
    setConfigDefaults({ "sentry.org": "sentry", "github.repo": "myorg/repo" });
    expect(getConfigDefaults()).toEqual({
      "sentry.org": "sentry",
      "github.repo": "myorg/repo",
    });
  });

  it("clears defaults when called with undefined", () => {
    setConfigDefaults({ "sentry.org": "sentry" });
    setConfigDefaults(undefined);
    expect(getConfigDefaults()).toEqual({});
  });

  it("rejects keys that are not registered plugin config keys", () => {
    expect(() => setConfigDefaults({ "unknown.key": "value" })).toThrow(
      "not a registered plugin config key",
    );
  });

  it("rejects null defaults", () => {
    expect(() =>
      setConfigDefaults(null as unknown as Record<string, unknown>),
    ).toThrow("configDefaults must be an object keyed by plugin config key");
  });

  it("rejects array defaults", () => {
    expect(() =>
      setConfigDefaults([] as unknown as Record<string, unknown>),
    ).toThrow("configDefaults must be an object keyed by plugin config key");
  });

  it("does not mutate the input object", () => {
    const input = { "sentry.org": "sentry" };
    setConfigDefaults(input);
    input["sentry.org"] = "changed";
    expect(getConfigDefaults()["sentry.org"]).toBe("sentry");
  });

  it("does not share nested input values", () => {
    const input = {
      "sentry.org": { slug: "sentry" },
    };
    setConfigDefaults(input);
    input["sentry.org"].slug = "changed";
    expect(getConfigDefaults()["sentry.org"]).toEqual({ slug: "sentry" });
  });

  it("does not expose mutable defaults", () => {
    setConfigDefaults({ "sentry.org": "sentry" });
    getConfigDefaults()["sentry.org"] = "changed";
    expect(getConfigDefaults()["sentry.org"]).toBe("sentry");
  });

  it("does not expose nested mutable defaults", () => {
    setConfigDefaults({ "sentry.org": { slug: "sentry" } });
    (getConfigDefaults()["sentry.org"] as { slug: string }).slug = "changed";
    expect(getConfigDefaults()["sentry.org"]).toEqual({ slug: "sentry" });
  });
});
