import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthBearerBroker } from "@/chat/plugins/auth/oauth-bearer-broker";
import type {
  OAuthBearerCredentials,
  PluginManifest,
} from "@/chat/plugins/types";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import type {
  StoredTokens,
  UserTokenStore,
} from "@/chat/credentials/user-token-store";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const SENTRY_SCOPE = "event:read org:read project:read team:read";

const SENTRY_MANIFEST: PluginManifest = {
  name: "sentry",
  description: "Sentry issue tracking",
  capabilities: ["sentry.api"],
  configKeys: ["sentry.org", "sentry.project"],
  credentials: {
    type: "oauth-bearer",
    apiDomains: ["sentry.io", "us.sentry.io", "de.sentry.io"],
    authTokenEnv: "SENTRY_AUTH_TOKEN",
  },
  oauth: {
    clientIdEnv: "SENTRY_CLIENT_ID",
    clientSecretEnv: "SENTRY_CLIENT_SECRET",
    authorizeEndpoint: "https://sentry.io/oauth/authorize/",
    tokenEndpoint: "https://sentry.io/oauth/token/",
    scope: SENTRY_SCOPE,
  },
};

function createMockTokenStore(
  tokens?: Record<string, StoredTokens>,
): UserTokenStore {
  const store = new Map<string, StoredTokens>();
  if (tokens) {
    for (const [key, value] of Object.entries(tokens)) {
      store.set(key, value);
    }
  }
  return {
    get: async (userId: string, provider: string) =>
      store.get(`${userId}:${provider}`),
    set: async (userId: string, provider: string, t: StoredTokens) => {
      store.set(`${userId}:${provider}`, t);
    },
    delete: async (userId: string, provider: string) => {
      store.delete(`${userId}:${provider}`);
    },
  };
}

function createBroker(tokenStore?: UserTokenStore) {
  return createOAuthBearerBroker(
    SENTRY_MANIFEST,
    SENTRY_MANIFEST.credentials as OAuthBearerCredentials,
    { userTokenStore: tokenStore ?? createMockTokenStore() },
  );
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("sentry credential broker (oauth-bearer plugin)", () => {
  it("issues a lease from a per-user OAuth token", async () => {
    const tokenStore = createMockTokenStore({
      "U123:sentry": {
        accessToken: "user-access-token",
        refreshToken: "user-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope: SENTRY_SCOPE,
      },
    });

    const broker = createBroker(tokenStore);
    const lease = await broker.issue({
      reason: "test:oauth",
      requesterId: "U123",
    });

    expect(lease.provider).toBe("sentry");
    expect(lease.env).toEqual({ SENTRY_AUTH_TOKEN: "host_managed_credential" });
    expect(lease.headerTransforms).toEqual([
      {
        domain: "sentry.io",
        headers: { Authorization: "Bearer user-access-token" },
      },
      {
        domain: "us.sentry.io",
        headers: { Authorization: "Bearer user-access-token" },
      },
      {
        domain: "de.sentry.io",
        headers: { Authorization: "Bearer user-access-token" },
      },
    ]);
  });

  it("falls back to a static env token when no per-user token exists", async () => {
    process.env.SENTRY_AUTH_TOKEN = "static-env-token";
    const broker = createBroker();
    const lease = await broker.issue({
      reason: "test:env-fallback",
    });

    expect(lease.provider).toBe("sentry");
    expect(lease.env).toEqual({ SENTRY_AUTH_TOKEN: "host_managed_credential" });
    expect(lease.headerTransforms).toEqual([
      {
        domain: "sentry.io",
        headers: { Authorization: "Bearer static-env-token" },
      },
      {
        domain: "us.sentry.io",
        headers: { Authorization: "Bearer static-env-token" },
      },
      {
        domain: "de.sentry.io",
        headers: { Authorization: "Bearer static-env-token" },
      },
    ]);
  });

  it("throws CredentialUnavailableError when no credentials are available", async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    const broker = createBroker();

    await expect(
      broker.issue({
        reason: "test:unavailable",
      }),
    ).rejects.toThrow(CredentialUnavailableError);
  });

  it("refreshes tokens that are near expiry", async () => {
    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";

    const tokenStore = createMockTokenStore({
      "U123:sentry": {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: Date.now() + 2 * 60 * 1000,
        scope: SENTRY_SCOPE,
      },
    });

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch;

    const broker = createBroker(tokenStore);
    const lease = await broker.issue({
      reason: "test:refresh",
      requesterId: "U123",
    });

    expect(lease.headerTransforms).toEqual([
      {
        domain: "sentry.io",
        headers: { Authorization: "Bearer new-access-token" },
      },
      {
        domain: "us.sentry.io",
        headers: { Authorization: "Bearer new-access-token" },
      },
      {
        domain: "de.sentry.io",
        headers: { Authorization: "Bearer new-access-token" },
      },
    ]);

    const stored = await tokenStore.get("U123", "sentry");
    expect(stored?.accessToken).toBe("new-access-token");
    expect(stored?.refreshToken).toBe("new-refresh-token");
  });

  it("requires stored tokens to include the configured OAuth scope", async () => {
    const tokenStore = createMockTokenStore({
      "U123:sentry": {
        accessToken: "user-access-token",
        refreshToken: "user-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope: "event:read",
      },
    });

    const broker = createBroker(tokenStore);
    await expect(
      broker.issue({
        reason: "test:scope-mismatch",
        requesterId: "U123",
      }),
    ).rejects.toThrow(CredentialUnavailableError);
  });
});
