import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnvApiKey: vi.fn(),
  getVercelOidcToken: vi.fn(),
}));

vi.mock("@/chat/pi/sdk", () => ({
  getEnvApiKey: mocks.getEnvApiKey,
}));

vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: mocks.getVercelOidcToken,
}));

import {
  getGatewayApiKey,
  getPiGatewayApiKey,
  MISSING_GATEWAY_CREDENTIALS_ERROR,
  resolveGatewayCredential,
} from "@/chat/pi/gateway-auth";

describe("resolveGatewayCredential", () => {
  beforeEach(() => {
    mocks.getEnvApiKey.mockReset();
    mocks.getVercelOidcToken.mockReset();
    mocks.getEnvApiKey.mockReturnValue(undefined);
    mocks.getVercelOidcToken.mockRejectedValue(new Error("oidc unavailable"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prefers runtime OIDC over an explicit API key", async () => {
    mocks.getVercelOidcToken.mockResolvedValue("  oidc-token  ");
    mocks.getEnvApiKey.mockReturnValue("api-key");

    await expect(resolveGatewayCredential()).resolves.toEqual({
      mode: "oidc",
      token: "oidc-token",
    });
  });

  it("falls back to AI_GATEWAY_API_KEY when OIDC is unavailable", async () => {
    mocks.getVercelOidcToken.mockRejectedValue(
      new Error("The 'x-vercel-oidc-token' header is missing from the request."),
    );
    mocks.getEnvApiKey.mockReturnValue("  api-key  ");

    await expect(resolveGatewayCredential()).resolves.toEqual({
      mode: "api_key",
      token: "api-key",
    });
  });

  it("returns undefined when neither OIDC nor API key is available", async () => {
    await expect(resolveGatewayCredential()).resolves.toBeUndefined();
  });

  it("ignores blank OIDC tokens and continues to the API key", async () => {
    mocks.getVercelOidcToken.mockResolvedValue("   ");
    mocks.getEnvApiKey.mockReturnValue("api-key");

    await expect(resolveGatewayCredential()).resolves.toEqual({
      mode: "api_key",
      token: "api-key",
    });
  });
});

describe("getGatewayApiKey", () => {
  beforeEach(() => {
    mocks.getEnvApiKey.mockReset();
    mocks.getVercelOidcToken.mockReset();
    mocks.getEnvApiKey.mockReturnValue(undefined);
    mocks.getVercelOidcToken.mockRejectedValue(new Error("oidc unavailable"));
  });

  it("returns the resolved bearer token", async () => {
    mocks.getVercelOidcToken.mockResolvedValue("oidc-token");

    await expect(getGatewayApiKey()).resolves.toBe("oidc-token");
  });

  it("returns undefined when no credential is available", async () => {
    await expect(getGatewayApiKey()).resolves.toBeUndefined();
  });
});

describe("getPiGatewayApiKey", () => {
  beforeEach(() => {
    mocks.getEnvApiKey.mockReset();
    mocks.getVercelOidcToken.mockReset();
    mocks.getEnvApiKey.mockReturnValue(undefined);
    mocks.getVercelOidcToken.mockRejectedValue(new Error("oidc unavailable"));
  });

  it("returns the same token shape used by Pi Agent getApiKey hooks", async () => {
    mocks.getEnvApiKey.mockReturnValue("api-key");

    await expect(getPiGatewayApiKey()).resolves.toBe("api-key");
  });
});

describe("MISSING_GATEWAY_CREDENTIALS_ERROR", () => {
  it("points operators at OIDC first", () => {
    expect(MISSING_GATEWAY_CREDENTIALS_ERROR).toContain("Vercel OIDC");
    expect(MISSING_GATEWAY_CREDENTIALS_ERROR).toContain("AI_GATEWAY_API_KEY");
  });
});
