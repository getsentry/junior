import { afterEach, describe, expect, it } from "vitest";
import { getGatewayApiKey } from "@/chat/pi/client";

const ORIGINAL_ENV = {
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
  VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN,
  VERCEL: process.env.VERCEL,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_REGION: process.env.VERCEL_REGION,
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
    restoreEnvVar("VERCEL");
    restoreEnvVar("VERCEL_ENV");
    restoreEnvVar("VERCEL_REGION");
  });

  it("prefers explicit AI gateway API key", () => {
    process.env.AI_GATEWAY_API_KEY = "  api-key  ";
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_REGION;

    expect(getGatewayApiKey()).toBe("api-key");
  });

  it("ignores Vercel OIDC token outside Vercel runtime", () => {
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_REGION;

    expect(getGatewayApiKey()).toBeUndefined();
  });

  it("allows Vercel OIDC token in Vercel runtime", () => {
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";
    process.env.VERCEL = "1";
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_REGION;

    expect(getGatewayApiKey()).toBe("oidc-token");
  });
});
