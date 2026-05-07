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

  it("does not mutate the input object", () => {
    const input = { "sentry.org": "sentry" };
    setConfigDefaults(input);
    input["sentry.org"] = "changed";
    expect(getConfigDefaults()["sentry.org"]).toBe("sentry");
  });
});
