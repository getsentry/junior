import { afterEach, describe, expect, it, vi } from "vitest";
import { gocdPlugin } from "../src";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("gocdPlugin", () => {
  it("omits network settings until a base URL is configured", () => {
    vi.stubEnv("GOCD_URL", "");
    const plugin = gocdPlugin();
    expect(plugin.packageName).toBe("@sentry/junior-gocd");
    expect(plugin.manifest).toMatchObject({
      name: "gocd",
      envVars: {
        GOCD_ACCESS_TOKEN: {},
        GOCD_URL: {},
      },
    });
    expect(plugin.manifest.domains).toBeUndefined();
    expect(plugin.manifest.apiHeaders).toBeUndefined();
  });

  it("allows the configured domain and adds the bearer token", () => {
    const plugin = gocdPlugin({ baseUrl: "https://gocd.example.com:8154" });
    expect(plugin.manifest).toMatchObject({
      apiHeaders: {
        Authorization: "bearer ${GOCD_ACCESS_TOKEN}",
      },
      domains: ["gocd.example.com"],
    });
    expect(
      plugin.hooks?.tools?.({
        egress: { fetch: vi.fn() },
      } as never),
    ).toMatchObject({
      pipelineHistory: expect.any(Object),
      stage: expect.any(Object),
    });
  });

  it("uses the domain from GOCD_URL", () => {
    vi.stubEnv("GOCD_URL", "https://ci.example.org");
    expect(gocdPlugin().manifest.domains).toEqual(["ci.example.org"]);
  });

  it("rejects invalid configured base URLs during registration", () => {
    expect(() => gocdPlugin({ baseUrl: "http://gocd.example.com" })).toThrow(
      "GoCD base URL must use https",
    );
  });

  it("uses host credential hooks instead of static apiHeaders", () => {
    const grantForEgress = vi.fn(() => ({
      access: "read" as const,
      name: "iap-read",
      reason: "test",
    }));
    const issueCredential = vi.fn();
    const plugin = gocdPlugin({
      baseUrl: "https://gocd.example.com",
      hooks: { grantForEgress, issueCredential },
    });
    expect(plugin.manifest.domains).toEqual(["gocd.example.com"]);
    expect(plugin.manifest.apiHeaders).toBeUndefined();
    expect(plugin.hooks?.grantForEgress).toBe(grantForEgress);
    expect(plugin.hooks?.issueCredential).toBe(issueCredential);
  });
});
