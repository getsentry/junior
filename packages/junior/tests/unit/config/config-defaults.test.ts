import { describe, expect, it } from "vitest";
import { getConfigDefaults } from "@/chat/configuration/defaults";
import { useConfig } from "../../fixtures/config";

describe("install config defaults", () => {
  it("returns an empty object when no defaults are set", () => {
    useConfig();
    expect(getConfigDefaults()).toEqual({});
  });

  it("stores and retrieves defaults", () => {
    useConfig({
      configDefaults: { "sentry.org": "sentry", "github.repo": "myorg/repo" },
    });
    expect(getConfigDefaults()).toEqual({
      "sentry.org": "sentry",
      "github.repo": "myorg/repo",
    });
  });

  it("stores unregistered plugin config keys", () => {
    useConfig({ configDefaults: { "unknown.key": "value" } });

    expect(getConfigDefaults()).toEqual({ "unknown.key": "value" });
  });

  it("rejects null defaults", () => {
    expect(() => useConfig({ configDefaults: null })).toThrow(
      "configDefaults must be an object keyed by plugin config key",
    );
  });

  it("rejects array defaults", () => {
    expect(() => useConfig({ configDefaults: [] })).toThrow(
      "configDefaults must be an object keyed by plugin config key",
    );
  });

  it("does not mutate the input object", () => {
    const input = { "sentry.org": "sentry" };
    useConfig({ configDefaults: input });
    input["sentry.org"] = "changed";
    expect(getConfigDefaults()["sentry.org"]).toBe("sentry");
  });

  it("does not share nested input values", () => {
    const input = {
      "sentry.org": { slug: "sentry" },
    };
    useConfig({ configDefaults: input });
    input["sentry.org"].slug = "changed";
    expect(getConfigDefaults()["sentry.org"]).toEqual({ slug: "sentry" });
  });

  it("does not expose mutable defaults", () => {
    useConfig({ configDefaults: { "sentry.org": "sentry" } });
    getConfigDefaults()["sentry.org"] = "changed";
    expect(getConfigDefaults()["sentry.org"]).toBe("sentry");
  });

  it("does not expose nested mutable defaults", () => {
    useConfig({ configDefaults: { "sentry.org": { slug: "sentry" } } });
    (getConfigDefaults()["sentry.org"] as { slug: string }).slug = "changed";
    expect(getConfigDefaults()["sentry.org"]).toEqual({ slug: "sentry" });
  });
});
