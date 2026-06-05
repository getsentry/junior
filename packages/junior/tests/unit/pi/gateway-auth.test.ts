import { describe, expect, it } from "vitest";
import { getGatewayApiKey, getPiGatewayApiKeyOverride } from "@/chat/pi/client";
import { stubTestEnv } from "../../fixtures/vitest";

describe("getGatewayApiKey", () => {
  it("prefers explicit AI gateway API key", () => {
    stubTestEnv({
      AI_GATEWAY_API_KEY: "  api-key  ",
      VERCEL_OIDC_TOKEN: "oidc-token",
    });

    expect(getGatewayApiKey()).toBe("api-key");
  });

  it("uses Vercel OIDC token from env when no API key is configured", () => {
    stubTestEnv({
      AI_GATEWAY_API_KEY: undefined,
      VERCEL_OIDC_TOKEN: "oidc-token",
    });

    expect(getGatewayApiKey()).toBe("oidc-token");
  });
});

describe("getPiGatewayApiKeyOverride", () => {
  it("only overrides pi-ai auth when VERCEL_OIDC_TOKEN is present", () => {
    stubTestEnv({
      AI_GATEWAY_API_KEY: "api-key",
      VERCEL_OIDC_TOKEN: "oidc-token",
    });

    expect(getPiGatewayApiKeyOverride()).toBe("oidc-token");
  });

  it("returns undefined when pi-ai should keep using its own env lookup", () => {
    stubTestEnv({
      AI_GATEWAY_API_KEY: "api-key",
      VERCEL_OIDC_TOKEN: undefined,
    });

    expect(getPiGatewayApiKeyOverride()).toBeUndefined();
  });
});
