import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthBearerBroker } from "@/chat/plugins/oauth-bearer-broker";
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
    scope: "event:read org:read project:read",
  },
};

const NOTION_MANIFEST: PluginManifest = {
  name: "notion",
  description: "Notion search",
  capabilities: ["notion.api"],
  configKeys: [],
  credentials: {
    type: "oauth-bearer",
    apiDomains: ["api.notion.com"],
    apiHeaders: {
      "Notion-Version": "2025-09-03",
    },
    authTokenEnv: "NOTION_TOKEN",
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
  it("issues lease from per-user OAuth token", async () => {
    const tokenStore = createMockTokenStore({
      "U123:sentry": {
        accessToken: "user-access-token",
        refreshToken: "user-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });

    const broker = createBroker(tokenStore);
    const lease = await broker.issue({
      capability: "sentry.api",
      reason: "test:oauth",
      requesterId: "U123",
    });

    expect(lease.provider).toBe("sentry");
    expect(lease.capability).toBe("sentry.api");
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

  it("falls back to SENTRY_AUTH_TOKEN env var", async () => {
    process.env.SENTRY_AUTH_TOKEN = "static-env-token";
    const broker = createBroker();
    const lease = await broker.issue({
      capability: "sentry.api",
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
        capability: "sentry.api",
        reason: "test:unavailable",
      }),
    ).rejects.toThrow(CredentialUnavailableError);
  });

  it("rejects unsupported capabilities", async () => {
    process.env.SENTRY_AUTH_TOKEN = "token";
    const broker = createBroker();

    await expect(
      broker.issue({
        capability: "sentry.admin.write",
        reason: "test:unsupported",
      }),
    ).rejects.toThrow("Unsupported sentry capability: sentry.admin.write");
  });

  it("refreshes token when near expiry", async () => {
    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";

    const tokenStore = createMockTokenStore({
      "U123:sentry": {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: Date.now() + 2 * 60 * 1000, // 2 min from now, within 5 min buffer
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
      capability: "sentry.api",
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

    // Verify updated tokens were stored
    const stored = await tokenStore.get("U123", "sentry");
    expect(stored?.accessToken).toBe("new-access-token");
    expect(stored?.refreshToken).toBe("new-refresh-token");
  });

  it("uses current token when refresh fails and token is still valid", async () => {
    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";

    const tokenStore = createMockTokenStore({
      "U123:sentry": {
        accessToken: "still-valid-token",
        refreshToken: "bad-refresh-token",
        expiresAt: Date.now() + 2 * 60 * 1000,
      },
    });

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
    })) as unknown as typeof fetch;

    const broker = createBroker(tokenStore);
    const lease = await broker.issue({
      capability: "sentry.api",
      reason: "test:refresh-fail-fallback",
      requesterId: "U123",
    });

    expect(lease.headerTransforms).toEqual([
      {
        domain: "sentry.io",
        headers: { Authorization: "Bearer still-valid-token" },
      },
      {
        domain: "us.sentry.io",
        headers: { Authorization: "Bearer still-valid-token" },
      },
      {
        domain: "de.sentry.io",
        headers: { Authorization: "Bearer still-valid-token" },
      },
    ]);
  });

  it("throws CredentialUnavailableError when refresh fails and token is expired", async () => {
    process.env.SENTRY_CLIENT_ID = "client-id";
    process.env.SENTRY_CLIENT_SECRET = "client-secret";

    const tokenStore = createMockTokenStore({
      "U123:sentry": {
        accessToken: "expired-token",
        refreshToken: "bad-refresh-token",
        expiresAt: Date.now() - 1000, // already expired
      },
    });

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
    })) as unknown as typeof fetch;

    const broker = createBroker(tokenStore);

    await expect(
      broker.issue({
        capability: "sentry.api",
        reason: "test:expired",
        requesterId: "U123",
      }),
    ).rejects.toThrow(CredentialUnavailableError);
  });

  it("throws CredentialUnavailableError when stored token is expired with no refresh buffer", async () => {
    const tokenStore = createMockTokenStore({
      "U123:sentry": {
        accessToken: "expired-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() - 1000,
      },
    });

    const broker = createBroker(tokenStore);

    await expect(
      broker.issue({
        capability: "sentry.api",
        reason: "test:expired-no-refresh",
        requesterId: "U123",
      }),
    ).rejects.toThrow(CredentialUnavailableError);
  });

  it("throws CredentialUnavailableError for requester with no stored token even when SENTRY_AUTH_TOKEN is set", async () => {
    process.env.SENTRY_AUTH_TOKEN = "static-env-token";
    const tokenStore = createMockTokenStore(); // empty — no stored tokens

    const broker = createBroker(tokenStore);

    await expect(
      broker.issue({
        capability: "sentry.api",
        reason: "test:requester-no-token",
        requesterId: "U999",
      }),
    ).rejects.toThrow(CredentialUnavailableError);
  });

  it("uses SENTRY_AUTH_TOKEN env var only without requester context", async () => {
    process.env.SENTRY_AUTH_TOKEN = "static-env-token";
    const tokenStore = createMockTokenStore();

    const broker = createBroker(tokenStore);

    // With requesterId → should throw (no per-user token)
    await expect(
      broker.issue({
        capability: "sentry.api",
        reason: "test:with-requester",
        requesterId: "U999",
      }),
    ).rejects.toThrow(CredentialUnavailableError);

    // Without requesterId → should use static token
    const lease = await broker.issue({
      capability: "sentry.api",
      reason: "test:without-requester",
    });
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

  it("uses placeholder in env, not real token", async () => {
    process.env.SENTRY_AUTH_TOKEN = "real-secret-token";
    const broker = createBroker();
    const lease = await broker.issue({
      capability: "sentry.api",
      reason: "test:placeholder",
    });

    expect(lease.env.SENTRY_AUTH_TOKEN).toBe("host_managed_credential");
    expect(lease.env.SENTRY_AUTH_TOKEN).not.toBe("real-secret-token");
  });

  it("uses configured auth token placeholder when provided by plugin config", async () => {
    process.env.SENTRY_AUTH_TOKEN = "real-secret-token";
    const broker = createOAuthBearerBroker(
      SENTRY_MANIFEST,
      {
        ...(SENTRY_MANIFEST.credentials as OAuthBearerCredentials),
        authTokenPlaceholder: "sntr_fake_cli_token",
      },
      { userTokenStore: createMockTokenStore() },
    );
    const lease = await broker.issue({
      capability: "sentry.api",
      reason: "test:custom-placeholder",
    });

    expect(lease.env.SENTRY_AUTH_TOKEN).toBe("sntr_fake_cli_token");
    expect(lease.env.SENTRY_AUTH_TOKEN).not.toBe("real-secret-token");
  });

  it("uses shared env tokens for non-oauth bearer plugins and merges api headers", async () => {
    process.env.NOTION_TOKEN = "notion-env-token";
    const tokenStore = createMockTokenStore();

    const broker = createOAuthBearerBroker(
      NOTION_MANIFEST,
      NOTION_MANIFEST.credentials as OAuthBearerCredentials,
      { userTokenStore: tokenStore },
    );
    const lease = await broker.issue({
      capability: "notion.api",
      reason: "test:notion",
      requesterId: "U777",
    });

    expect(lease.headerTransforms).toEqual([
      {
        domain: "api.notion.com",
        headers: {
          "Notion-Version": "2025-09-03",
          Authorization: "Bearer notion-env-token",
        },
      },
    ]);
  });
});
