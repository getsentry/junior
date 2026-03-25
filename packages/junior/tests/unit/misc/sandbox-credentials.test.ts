import { afterEach, describe, expect, it } from "vitest";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";

const REQUEST_CONTEXT_SYMBOL = Symbol.for("@vercel/request-context");

const TEST_ENV_KEYS = [
  "VERCEL_OIDC_TOKEN",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
] as const;

const ORIGINAL_REQUEST_CONTEXT = (
  globalThis as typeof globalThis & {
    [REQUEST_CONTEXT_SYMBOL]?: {
      get?: () => { headers?: Record<string, string> };
    };
  }
)[REQUEST_CONTEXT_SYMBOL];

function clearTestEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
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

describe("getVercelSandboxCredentials", () => {
  afterEach(() => {
    clearTestEnv();
    restoreRequestContext();
  });

  it("returns explicit sandbox credentials when the full token triple is set", () => {
    process.env.VERCEL_TOKEN = "sandbox-token";
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";

    expect(getVercelSandboxCredentials()).toEqual({
      token: "sandbox-token",
      teamId: "team_123",
      projectId: "prj_123",
    });
  });

  it("throws for incomplete explicit credentials without ambient OIDC", () => {
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";

    expect(() => getVercelSandboxCredentials()).toThrow(
      "Missing Vercel Sandbox credentials",
    );
  });

  it("defers to SDK OIDC resolution when VERCEL_OIDC_TOKEN is set", () => {
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";

    expect(getVercelSandboxCredentials()).toBeUndefined();
  });

  it("defers to SDK OIDC resolution when request context exposes Vercel OIDC", () => {
    setRequestContextOidcToken("oidc-token");
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";

    expect(getVercelSandboxCredentials()).toBeUndefined();
  });
});
