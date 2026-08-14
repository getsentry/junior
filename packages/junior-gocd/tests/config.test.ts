import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostFromBaseUrl,
  resolveGocdApiUrl,
  resolveGocdTarget,
} from "../src/config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GoCD config", () => {
  it("requires https base URLs", () => {
    expect(hostFromBaseUrl("https://gocd.example.com")).toBe(
      "gocd.example.com",
    );
    expect(() => hostFromBaseUrl("http://gocd.example.com")).toThrow(
      "GoCD base URL must use https",
    );
  });

  it("builds API urls under /go/", () => {
    expect(
      resolveGocdApiUrl(
        "https://gocd.example.com/",
        "/go/api/pipelines/demo/history",
      ),
    ).toBe("https://gocd.example.com/go/api/pipelines/demo/history");
    expect(() =>
      resolveGocdApiUrl("https://gocd.example.com", "/api/version"),
    ).toThrow("GoCD API paths must start with /go/");
  });

  it("prefers explicit baseUrl over plugin options and env", () => {
    vi.stubEnv("GOCD_URL", "https://env.example.com");
    expect(
      resolveGocdTarget({
        baseUrl: "https://call.example.com",
        options: { baseUrl: "https://option.example.com" },
      }),
    ).toEqual({
      baseUrl: "https://call.example.com",
      host: "call.example.com",
    });
  });

  it("falls back to GOCD_URL", () => {
    vi.stubEnv("GOCD_URL", " https://env.example.com/ ");
    expect(resolveGocdTarget({})).toEqual({
      baseUrl: "https://env.example.com",
      host: "env.example.com",
    });
  });

  it("names a missing base URL", () => {
    vi.stubEnv("GOCD_URL", "");
    expect(() => resolveGocdTarget({})).toThrow("GoCD base URL is required");
  });
});
