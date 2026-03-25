import { afterEach, describe, expect, it } from "vitest";
import { getGatewayApiKey } from "@/chat/pi/client";

const REQUEST_CONTEXT_SYMBOL = Symbol.for("@vercel/request-context");

const ORIGINAL_ENV = {
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
  VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN,
};

const ORIGINAL_REQUEST_CONTEXT = (
  globalThis as typeof globalThis & {
    [REQUEST_CONTEXT_SYMBOL]?: {
      get?: () => { headers?: Record<string, string> };
    };
  }
)[REQUEST_CONTEXT_SYMBOL];

function restoreEnvVar(name: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[name];
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function restoreRequestContext(): void {
  const target = globalThis as typeof globalThis & {
    [REQUEST_CONTEXT_SYMBOL]?: {
      get?: () => { headers?: Record<string, string> };
    };
  };

  if (ORIGINAL_REQUEST_CONTEXT === undefined) {
    delete target[REQUEST_CONTEXT_SYMBOL];
    return;
  }

  target[REQUEST_CONTEXT_SYMBOL] = ORIGINAL_REQUEST_CONTEXT;
}

function setRequestContextOidcToken(token: string): void {
  (
    globalThis as typeof globalThis & {
      [REQUEST_CONTEXT_SYMBOL]?: {
        get?: () => { headers?: Record<string, string> };
      };
    }
  )[REQUEST_CONTEXT_SYMBOL] = {
    get: () => ({
      headers: {
        "x-vercel-oidc-token": token,
      },
    }),
  };
}

describe("getGatewayApiKey", () => {
  afterEach(() => {
    restoreEnvVar("AI_GATEWAY_API_KEY");
    restoreEnvVar("VERCEL_OIDC_TOKEN");
    restoreRequestContext();
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

  it("uses Vercel OIDC token from request context when env is absent", () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    setRequestContextOidcToken("oidc-token");

    expect(getGatewayApiKey()).toBe("oidc-token");
  });
});
