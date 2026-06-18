import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { createOAuthBearerBroker } from "@/chat/plugins/auth/oauth-bearer-broker";

const ORIGINAL_ENV = { ...process.env };

function manifest() {
  return {
    name: "oauth-broker",
    displayName: "OAuth Broker",
    description: "OAuth Broker",
    capabilities: ["api"],
    envVars: {},
    commandEnv: {},
    credentials: {
      type: "oauth-bearer" as const,
      domains: ["oauth-broker.example.test"],
      authTokenEnv: "OAUTH_BROKER_ACCESS_TOKEN",
      authTokenPlaceholder: "host_managed_credential",
    },
    oauth: {
      clientIdEnv: "OAUTH_BROKER_CLIENT_ID",
      clientSecretEnv: "OAUTH_BROKER_CLIENT_SECRET",
      authorizeEndpoint: "https://oauth-broker.example.test/authorize",
      tokenEndpoint: "https://oauth-broker.example.test/token",
      scope: "broker.read",
    },
  };
}

function tokenStore(storedToken: {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  scope?: string;
}) {
  return {
    get: vi.fn(async () => storedToken),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

describe("createOAuthBearerBroker refresh normalization", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      OAUTH_BROKER_CLIENT_ID: "client-id",
      OAUTH_BROKER_CLIENT_SECRET: "client-secret",
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("converts malformed successful refresh responses into CredentialUnavailableError", async () => {
    const store = tokenStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      scope: "broker.read",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad_refresh_token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const broker = createOAuthBearerBroker(manifest(), manifest().credentials, {
      userTokenStore: store,
    });

    await expect(
      broker.issue({
        context: { actor: { type: "user", userId: "U123" } },
        reason: "sandbox-egress:oauth-broker:default",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CredentialUnavailableError &&
        error.message === "Your oauth-broker connection has expired.",
    );
    expect(store.set).not.toHaveBeenCalled();
  });

  it("keeps operational token endpoint failures as raw errors", async () => {
    const store = tokenStore({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000,
      scope: "broker.read",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("server error", { status: 500 }),
    );

    const broker = createOAuthBearerBroker(manifest(), manifest().credentials, {
      userTokenStore: store,
    });

    await expect(
      broker.issue({
        context: { actor: { type: "user", userId: "U123" } },
        reason: "sandbox-egress:oauth-broker:default",
      }),
    ).rejects.toThrow("Token refresh failed: 500");
  });
});
