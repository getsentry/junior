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
const USER_CREDENTIAL_CONTEXT = {
  actor: { type: "user" as const, userId: "U123" },
};
const SYSTEM_CREDENTIAL_CONTEXT = {
  actor: { platform: "system" as const, name: "scheduler" },
};

const SENTRY_MANIFEST: PluginManifest = {
  name: "sentry",
  displayName: "Sentry",
  description: "Sentry issue tracking",
  capabilities: ["sentry.api"],
  configKeys: ["sentry.org", "sentry.project"],
  credentials: {
    type: "oauth-bearer",
    domains: ["us.sentry.io", "de.sentry.io"],
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
    withRefresh: async (_userId, _provider, callback) => callback(),
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
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:oauth",
    });

    expect(lease.provider).toBe("sentry");
    expect(lease.env).toEqual({ SENTRY_AUTH_TOKEN: "host_managed_credential" });
    expect(lease.headerTransforms).toEqual([
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
      context: SYSTEM_CREDENTIAL_CONTEXT,
      reason: "test:env-fallback",
    });

    expect(lease.provider).toBe("sentry");
    expect(lease.env).toEqual({ SENTRY_AUTH_TOKEN: "host_managed_credential" });
    expect(lease.headerTransforms).toEqual([
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

  it("merges plugin-level API headers with token-backed credential headers", async () => {
    process.env.SENTRY_AUTH_TOKEN = "static-env-token";
    process.env.SENTRY_EXTRA_AUTH = "ExtraHeader value";
    const manifest: PluginManifest = {
      ...SENTRY_MANIFEST,
      domains: ["uploads.sentry.io", "us.sentry.io"],
      apiHeaders: {
        Authorization: "${SENTRY_EXTRA_AUTH}",
        "X-Sentry-Mode": "sandbox",
      },
    };

    const broker = createOAuthBearerBroker(
      manifest,
      manifest.credentials as OAuthBearerCredentials,
      { userTokenStore: createMockTokenStore() },
    );
    const lease = await broker.issue({
      context: SYSTEM_CREDENTIAL_CONTEXT,
      reason: "test:plugin-api-headers",
    });

    expect(lease.headerTransforms).toEqual([
      {
        domain: "uploads.sentry.io",
        headers: {
          Authorization: "ExtraHeader value",
          "X-Sentry-Mode": "sandbox",
        },
      },
      {
        domain: "us.sentry.io",
        headers: {
          Authorization: "Bearer static-env-token",
          "X-Sentry-Mode": "sandbox",
        },
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
        context: SYSTEM_CREDENTIAL_CONTEXT,
        reason: "test:unavailable",
      }),
    ).rejects.toThrow(CredentialUnavailableError);
  });

  it("refreshes tokens that are near expiry", async () => {
    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    const refreshTokenExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

    const tokenStore = createMockTokenStore({
      "U123:sentry": {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        refreshTokenExpiresAt,
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
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:refresh",
    });

    expect(lease.headerTransforms).toEqual([
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
    expect(stored?.refreshTokenExpiresAt).toBe(refreshTokenExpiresAt);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://sentry.io/oauth/token/",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses the refreshed token expiry when the provider returns one", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(now);
    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    const oldRefreshTokenExpiresAt = now.getTime() + 30 * 24 * 60 * 60 * 1000;

    const tokenStore = createMockTokenStore({
      "U123:sentry": {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        refreshTokenExpiresAt: oldRefreshTokenExpiresAt,
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
        refresh_token_expires_in: 7200,
      }),
    })) as unknown as typeof fetch;

    const broker = createBroker(tokenStore);
    await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:refresh",
    });

    const stored = await tokenStore.get("U123", "sentry");
    expect(stored?.refreshTokenExpiresAt).toBe(now.getTime() + 7200_000);
  });

  it("uses tokens refreshed by another request before refreshing a stale token", async () => {
    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";
    const staleToken: StoredTokens = {
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: Date.now() + 2 * 60 * 1000,
      scope: SENTRY_SCOPE,
    };
    const freshToken: StoredTokens = {
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: SENTRY_SCOPE,
    };
    const get = vi
      .fn<UserTokenStore["get"]>()
      .mockResolvedValueOnce(staleToken)
      .mockResolvedValueOnce(freshToken);
    const withRefresh = vi.fn(async (_userId, _provider, callback) =>
      callback(),
    );
    const tokenStore: UserTokenStore = {
      get,
      set: vi.fn(),
      delete: vi.fn(),
      withRefresh,
    };
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const broker = createBroker(tokenStore);
    const lease = await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:refresh-race",
    });

    expect(withRefresh).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(lease.headerTransforms).toEqual([
      {
        domain: "us.sentry.io",
        headers: { Authorization: "Bearer new-access-token" },
      },
      {
        domain: "de.sentry.io",
        headers: { Authorization: "Bearer new-access-token" },
      },
    ]);
  });

  it("does not issue a stale lease when token refresh is rejected", async () => {
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

    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
    ) as unknown as typeof fetch;

    const broker = createBroker(tokenStore);
    await expect(
      broker.issue({
        context: USER_CREDENTIAL_CONTEXT,
        reason: "test:refresh-failure",
      }),
    ).rejects.toThrow(CredentialUnavailableError);
  });

  it("surfaces operational token refresh failures", async () => {
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

    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "server_error" }), {
          status: 500,
        }),
    ) as unknown as typeof fetch;

    const broker = createBroker(tokenStore);
    await expect(
      broker.issue({
        context: USER_CREDENTIAL_CONTEXT,
        reason: "test:refresh-failure",
      }),
    ).rejects.toThrow("Token refresh failed: 500 server_error");
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
        context: USER_CREDENTIAL_CONTEXT,
        reason: "test:scope-mismatch",
      }),
    ).rejects.toThrow(CredentialUnavailableError);
  });

  it("uses a delegated user subject for OAuth lookup under a system actor", async () => {
    const tokenStore = createMockTokenStore({
      "U123:sentry": {
        accessToken: "delegated-access-token",
        refreshToken: "delegated-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope: SENTRY_SCOPE,
      },
    });

    const broker = createBroker(tokenStore);
    const lease = await broker.issue({
      context: {
        actor: { platform: "system", name: "scheduler" },
        subject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
          binding: {
            type: "slack-direct-conversation",
            teamId: "T123",
            channelId: "D123",
            signature: "v1=test",
          },
        },
      },
      reason: "test:delegated-subject",
    });

    expect(lease.headerTransforms).toEqual([
      {
        domain: "us.sentry.io",
        headers: { Authorization: "Bearer delegated-access-token" },
      },
      {
        domain: "de.sentry.io",
        headers: { Authorization: "Bearer delegated-access-token" },
      },
    ]);
  });
});
