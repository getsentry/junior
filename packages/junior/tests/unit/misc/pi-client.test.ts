import { afterEach, describe, expect, it } from "vitest";
import { getGatewayApiKey, getPiGatewayApiKeyOverride } from "@/chat/pi/client";

const ORIGINAL_ENV = {
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
  VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN,
};

function restoreEnvVar(name: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[name];
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("getGatewayApiKey", () => {
  afterEach(() => {
    restoreEnvVar("AI_GATEWAY_API_KEY");
    restoreEnvVar("VERCEL_OIDC_TOKEN");
  });

  it("prefers explicit AI gateway API key", () => {
    process.env.AI_GATEWAY_API_KEY = "  api-key  ";
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";

    expect(getGatewayApiKey()).toBe("api-key");
  });

  it("uses Vercel OIDC token from env when no API key is configured", () => {
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";

    expect(getGatewayApiKey()).toBe("oidc-token");
  });
});

describe("getPiGatewayApiKeyOverride", () => {
  afterEach(() => {
    restoreEnvVar("AI_GATEWAY_API_KEY");
    restoreEnvVar("VERCEL_OIDC_TOKEN");
  });

  it("only overrides pi-ai auth when VERCEL_OIDC_TOKEN is present", () => {
    process.env.AI_GATEWAY_API_KEY = "api-key";
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";

    expect(getPiGatewayApiKeyOverride()).toBe("oidc-token");
  });

  it("returns undefined when pi-ai should keep using its own env lookup", () => {
    process.env.AI_GATEWAY_API_KEY = "api-key";
    delete process.env.VERCEL_OIDC_TOKEN;

    expect(getPiGatewayApiKeyOverride()).toBeUndefined();
  });
});
