import { afterEach, describe, expect, it } from "vitest";
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

  it("rejects keys that do not match the config key format", () => {
    expect(() => setConfigDefaults({ bad_key: "value" })).toThrow(
      "configDefaults",
    );
  });

  it("rejects keys that look like secrets", () => {
    expect(() => setConfigDefaults({ "my.token": "abc" })).toThrow(
      "secret-related",
    );
  });

  it("rejects values that contain secret material", () => {
    expect(() =>
      setConfigDefaults({
        "sentry.org": "Bearer abcdefghijklmnopqrstuvwxyz123456",
      }),
    ).toThrow("secret material");
  });

  it("does not mutate the input object", () => {
    const input = { "sentry.org": "sentry" };
    setConfigDefaults(input);
    input["sentry.org"] = "changed";
    expect(getConfigDefaults()["sentry.org"]).toBe("sentry");
  });
});
