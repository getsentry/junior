import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostnameFromBaseUrl,
  resolveGocdApiUrl,
  resolveGocdBaseUrl,
} from "../src/config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GoCD config", () => {
  it("requires https base URLs", () => {
    expect(hostnameFromBaseUrl("https://gocd.example.com")).toBe(
      "gocd.example.com",
    );
    expect(hostnameFromBaseUrl("https://gocd.example.com:8154")).toBe(
      "gocd.example.com",
    );
    expect(() => hostnameFromBaseUrl("http://gocd.example.com")).toThrow(
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

  it("prefers plugin options over the environment", () => {
    vi.stubEnv("GOCD_URL", "https://env.example.com");
    expect(
      resolveGocdBaseUrl({ baseUrl: "https://option.example.com:8154" }),
    ).toBe("https://option.example.com:8154");
  });

  it("falls back to GOCD_URL", () => {
    vi.stubEnv("GOCD_URL", " https://env.example.com/ ");
    expect(resolveGocdBaseUrl()).toBe("https://env.example.com");
  });

  it("names a missing base URL", () => {
    vi.stubEnv("GOCD_URL", "");
    expect(() => resolveGocdBaseUrl()).toThrow("GoCD base URL is required");
  });

  it("validates the configured base URL before use", () => {
    expect(() =>
      resolveGocdBaseUrl({ baseUrl: "http://gocd.example.com" }),
    ).toThrow("GoCD base URL must use https");
    expect(() =>
      resolveGocdBaseUrl({ baseUrl: "https://gocd.example.com/go" }),
    ).toThrow("GoCD base URL cannot include credentials, a path, a query");
  });
});
