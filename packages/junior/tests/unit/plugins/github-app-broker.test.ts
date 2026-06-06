import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { createGitHubAppBroker } from "@/chat/plugins/auth/github-app-broker";
import type {
  GitHubAppCredentials,
  PluginManifest,
} from "@/chat/plugins/types";
import type { StoredTokens } from "@/chat/credentials/user-token-store";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const TEST_CREDENTIALS: GitHubAppCredentials = {
  type: "github-app",
  domains: ["api.github.com", "github.com"],
  authTokenEnv: "GITHUB_TOKEN",
  appIdEnv: "GITHUB_APP_ID",
  privateKeyEnv: "GITHUB_APP_PRIVATE_KEY",
  installationIdEnv: "GITHUB_INSTALLATION_ID",
};

const TEST_MANIFEST: PluginManifest = {
  name: "github",
  description: "GitHub issue management via GitHub App",
  capabilities: [],
  configKeys: ["github.org", "github.repo"],
  credentials: TEST_CREDENTIALS,
  target: {
    type: "repo",
    configKey: "github.repo",
    commandFlags: ["--repo", "-R"],
  },
};
const TEST_OAUTH_MANIFEST: PluginManifest = {
  ...TEST_MANIFEST,
  oauth: {
    clientIdEnv: "GITHUB_APP_CLIENT_ID",
    clientSecretEnv: "GITHUB_APP_CLIENT_SECRET",
    authorizeEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    treatEmptyScopeAsUnreported: true,
  },
};

const TEST_OAUTH_MANIFEST_WITH_EXTRA_SCOPES: PluginManifest = {
  ...TEST_MANIFEST,
  oauth: {
    clientIdEnv: "GITHUB_APP_CLIENT_ID",
    clientSecretEnv: "GITHUB_APP_CLIENT_SECRET",
    authorizeEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    scope: "read:org repo",
    treatEmptyScopeAsUnreported: true,
  },
};
const USER_CREDENTIAL_CONTEXT = {
  actor: { type: "user" as const, userId: "U123" },
};
const SYSTEM_CREDENTIAL_CONTEXT = {
  actor: { type: "system" as const, id: "scheduler" },
};

function setupValidEnv() {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_CLIENT_ID = "client-id";
  process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  process.env.GITHUB_INSTALLATION_ID = "42";
}

function userTokenStore(tokens?: StoredTokens) {
  return {
    get: vi.fn(async () => tokens),
    set: vi.fn(async (_userId: string, _provider: string, value) => {
      tokens = value;
    }),
    delete: vi.fn(),
  };
}

function mockJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockGitHubApi(options?: {
  installationPermissions?: Record<string, string>;
  token?: string;
  onRequest?: (url: string, init?: RequestInit) => void;
}) {
  const token = options?.token ?? "issued-token";
  globalThis.fetch = vi.fn(async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String(input);
    options?.onRequest?.(url, init);

    if (url.includes("/access_tokens")) {
      return mockJsonResponse({
        token,
        expires_at: "2099-01-01T00:00:00Z",
      });
    }
    if (url.includes("/app/installations/42")) {
      return mockJsonResponse({
        permissions: options?.installationPermissions ?? {
          contents: "write",
          issues: "write",
          metadata: "read",
          pull_requests: "write",
        },
      });
    }
    throw new Error(`Unexpected fetch request: ${url}`);
  }) as unknown as typeof fetch;
}

function findAccessTokenCall() {
  const call = vi
    .mocked(globalThis.fetch)
    .mock.calls.find(([url]) => String(url).includes("/access_tokens"));
  expect(call).toBeDefined();
  return call!;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("github app credential broker", () => {
  it("issues a provider lease with the expected env and headers", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "issued-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:lease-shape",
    });

    expect(lease.provider).toBe("github");
    expect(lease.env).toEqual({
      GITHUB_TOKEN: "ghp_host_managed_credential",
    });
    expect(lease.headerTransforms).toEqual([
      {
        domain: "api.github.com",
        headers: { Authorization: "Bearer issued-token" },
      },
      {
        domain: "github.com",
        headers: {
          Authorization: `Basic ${Buffer.from("x-access-token:issued-token").toString("base64")}`,
        },
      },
    ]);
    expect(lease.metadata).toMatchObject({
      installationId: "42",
      reason: "test:lease-shape",
    });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("uses the configured auth token placeholder when provided", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "real-secret-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, {
      ...TEST_CREDENTIALS,
      authTokenPlaceholder: "github_host_managed_credential",
    });
    const lease = await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:custom-placeholder",
    });

    expect(lease.env.GITHUB_TOKEN).toBe("github_host_managed_credential");
  });

  it("derives REST and git auth modes from configured domains", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "enterprise-token" });
    const credentials: GitHubAppCredentials = {
      ...TEST_CREDENTIALS,
      domains: ["api.github.example", "github.example"],
    };

    const broker = createGitHubAppBroker(
      {
        ...TEST_MANIFEST,
        credentials,
      },
      credentials,
    );
    const lease = await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:configured-domains",
    });

    expect(String(findAccessTokenCall()[0])).toBe(
      "https://api.github.example/app/installations/42/access_tokens",
    );
    expect(lease.headerTransforms).toEqual([
      {
        domain: "api.github.example",
        headers: { Authorization: "Bearer enterprise-token" },
      },
      {
        domain: "github.example",
        headers: {
          Authorization: `Basic ${Buffer.from("x-access-token:enterprise-token").toString("base64")}`,
        },
      },
    ]);
  });

  it("uses bearer auth for non-git GitHub service domains", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "service-token" });
    const credentials: GitHubAppCredentials = {
      ...TEST_CREDENTIALS,
      domains: ["api.github.com", "github.com", "uploads.github.com"],
    };

    const broker = createGitHubAppBroker(
      {
        ...TEST_MANIFEST,
        credentials,
      },
      credentials,
    );
    const lease = await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:service-domains",
    });

    expect(lease.headerTransforms).toEqual([
      {
        domain: "api.github.com",
        headers: { Authorization: "Bearer service-token" },
      },
      {
        domain: "github.com",
        headers: {
          Authorization: `Basic ${Buffer.from("x-access-token:service-token").toString("base64")}`,
        },
      },
      {
        domain: "uploads.github.com",
        headers: { Authorization: "Bearer service-token" },
      },
    ]);
  });

  it("resolves the REST API domain independent of manifest ordering", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "reordered-token" });
    const credentials: GitHubAppCredentials = {
      ...TEST_CREDENTIALS,
      domains: ["github.com", "api.github.com"],
    };

    const broker = createGitHubAppBroker(
      {
        ...TEST_MANIFEST,
        credentials,
      },
      credentials,
    );
    const lease = await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:reordered-domains",
    });

    expect(String(findAccessTokenCall()[0])).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(lease.headerTransforms).toEqual([
      {
        domain: "github.com",
        headers: {
          Authorization: `Basic ${Buffer.from("x-access-token:reordered-token").toString("base64")}`,
        },
      },
      {
        domain: "api.github.com",
        headers: { Authorization: "Bearer reordered-token" },
      },
    ]);
  });

  it("mints fresh installation tokens on each broker issue", async () => {
    setupValidEnv();
    const issuedTokens = ["first-token", "second-token"];
    globalThis.fetch = vi.fn(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : String(input);
      if (url.includes("/access_tokens")) {
        return mockJsonResponse({
          token: issuedTokens.shift(),
          expires_at: "2099-01-01T00:00:00Z",
        });
      }
      throw new Error(`Unexpected fetch request: ${url}`);
    }) as unknown as typeof fetch;

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const firstLease = await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:first-token",
    });
    const secondLease = await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:second-token",
    });

    expect(firstLease.headerTransforms?.[0]).toEqual({
      domain: "api.github.com",
      headers: { Authorization: "Bearer first-token" },
    });
    expect(secondLease.headerTransforms?.[0]).toEqual({
      domain: "api.github.com",
      headers: { Authorization: "Bearer second-token" },
    });
    const accessTokenCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).includes("/access_tokens"));
    expect(accessTokenCalls).toHaveLength(2);
  });

  it("omits permissions from token request when no capabilities are declared", async () => {
    setupValidEnv();
    mockGitHubApi();

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:permissions",
    });

    const fetchCall = findAccessTokenCall();
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.permissions).toBeUndefined();
    expect(body.repositories).toBeUndefined();
  });

  it("scopes token permissions from capabilities when declared", async () => {
    setupValidEnv();
    mockGitHubApi();

    const manifestWithCaps: PluginManifest = {
      ...TEST_MANIFEST,
      capabilities: ["github.issues.read", "github.issues.write"],
    };
    const broker = createGitHubAppBroker(manifestWithCaps, TEST_CREDENTIALS);
    await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:scoped-permissions",
    });

    const fetchCall = findAccessTokenCall();
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.permissions).toEqual({ issues: "write" });
  });

  it("downgrades GitHub App installation permissions for system actors", async () => {
    setupValidEnv();
    mockGitHubApi({
      installationPermissions: {
        actions: "write",
        administration: "write",
        checks: "write",
        contents: "write",
        issues: "write",
        metadata: "read",
        pull_requests: "write",
        secrets: "write",
        security_events: "write",
        statuses: "write",
        unknown_preview_permission: "write",
      },
    });

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await broker.issue({
      context: SYSTEM_CREDENTIAL_CONTEXT,
      reason: "test:system-read-only",
    });

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(String(calls[0]?.[0])).toBe(
      "https://api.github.com/app/installations/42",
    );
    const accessTokenCall = findAccessTokenCall();
    const body = JSON.parse(accessTokenCall[1]?.body as string);
    expect(body.permissions).toEqual({
      actions: "read",
      checks: "read",
      contents: "read",
      issues: "read",
      metadata: "read",
      pull_requests: "read",
      statuses: "read",
    });
  });

  it("does not use manifest capabilities as the system permission override", async () => {
    setupValidEnv();
    mockGitHubApi({
      installationPermissions: {
        contents: "write",
        deployments: "write",
        issues: "write",
        metadata: "read",
      },
    });

    const manifestWithCaps: PluginManifest = {
      ...TEST_MANIFEST,
      capabilities: ["github.deployments.write"],
    };
    const broker = createGitHubAppBroker(manifestWithCaps, TEST_CREDENTIALS);
    await broker.issue({
      context: SYSTEM_CREDENTIAL_CONTEXT,
      reason: "test:system-default-permissions",
    });

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(String(calls[0]?.[0])).toBe(
      "https://api.github.com/app/installations/42",
    );
    const fetchCall = findAccessTokenCall();
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.permissions).toEqual({
      contents: "read",
      issues: "read",
      metadata: "read",
    });
  });

  it("uses configured system read permissions as the system permission override", async () => {
    setupValidEnv();
    mockGitHubApi();
    const credentials: GitHubAppCredentials = {
      ...TEST_CREDENTIALS,
      systemReadPermissions: ["deployments", "pull-requests"],
    };
    const manifestWithCaps: PluginManifest = {
      ...TEST_MANIFEST,
      capabilities: ["github.secrets.write"],
      credentials,
    };

    const broker = createGitHubAppBroker(manifestWithCaps, credentials);
    await broker.issue({
      context: SYSTEM_CREDENTIAL_CONTEXT,
      reason: "test:system-configured-permissions",
    });

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls.map((call) => String(call[0]))).not.toContain(
      "https://api.github.com/app/installations/42",
    );
    const fetchCall = findAccessTokenCall();
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.permissions).toEqual({
      deployments: "read",
      metadata: "read",
      pull_requests: "read",
    });
  });

  it("uses stored GitHub user tokens for write-intent leases", async () => {
    setupValidEnv();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("installation token should not be requested");
    }) as unknown as typeof fetch;
    const store = userTokenStore({
      accessToken: "user-token",
      refreshToken: "user-refresh-token",
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    const broker = createGitHubAppBroker(
      TEST_OAUTH_MANIFEST,
      TEST_CREDENTIALS,
      { userTokenStore: store },
    );
    const lease = await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      intent: "write",
      reason: "test:user-write",
    });

    expect(store.get).toHaveBeenCalledWith("U123", "github");
    expect(lease.headerTransforms).toEqual([
      {
        domain: "api.github.com",
        headers: { Authorization: "Bearer user-token" },
      },
      {
        domain: "github.com",
        headers: {
          Authorization: `Basic ${Buffer.from("x-access-token:user-token").toString("base64")}`,
        },
      },
    ]);
    expect(lease.metadata).toMatchObject({
      reason: "test:user-write",
      tokenKind: "user",
    });
    expect(lease.metadata).not.toHaveProperty("installationId");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requires GitHub user authorization for write-intent leases", async () => {
    setupValidEnv();
    const broker = createGitHubAppBroker(
      TEST_OAUTH_MANIFEST,
      TEST_CREDENTIALS,
      { userTokenStore: userTokenStore() },
    );

    await expect(
      broker.issue({
        context: USER_CREDENTIAL_CONTEXT,
        intent: "write",
        reason: "test:missing-user-token",
      }),
    ).rejects.toBeInstanceOf(CredentialUnavailableError);
  });

  it("does not use delegated user tokens for system actor write-intent leases", async () => {
    setupValidEnv();
    const store = userTokenStore({
      accessToken: "delegated-user-token",
      refreshToken: "delegated-refresh-token",
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    const broker = createGitHubAppBroker(
      TEST_OAUTH_MANIFEST,
      TEST_CREDENTIALS,
      { userTokenStore: store },
    );

    await expect(
      broker.issue({
        context: {
          actor: { type: "system", id: "scheduler" },
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
        intent: "write",
        reason: "test:system-delegated-write",
      }),
    ).rejects.toBeInstanceOf(CredentialUnavailableError);
    expect(store.get).not.toHaveBeenCalled();
  });

  it("accepts stored GitHub user token whose scope was populated via treatEmptyScopeAsUnreported fallback", async () => {
    setupValidEnv();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("installation token should not be requested");
    }) as unknown as typeof fetch;
    // Callback stores token with fallback scope since GitHub App tokens return scope: ""
    const store = userTokenStore({
      accessToken: "user-token",
      refreshToken: "user-refresh-token",
      expiresAt: Date.now() + 30 * 60 * 1000,
      scope: "read:org repo",
    });

    const broker = createGitHubAppBroker(
      TEST_OAUTH_MANIFEST_WITH_EXTRA_SCOPES,
      TEST_CREDENTIALS,
      { userTokenStore: store },
    );
    const lease = await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      intent: "write",
      reason: "test:extra-scopes-fallback-scope",
    });

    expect(lease.headerTransforms?.[0]).toEqual({
      domain: "api.github.com",
      headers: { Authorization: "Bearer user-token" },
    });
  });

  it("refreshes expiring GitHub user tokens before write leases", async () => {
    setupValidEnv();
    const store = userTokenStore({
      accessToken: "old-user-token",
      refreshToken: "old-refresh-token",
      expiresAt: Date.now() + 30_000,
    });
    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://github.com/login/oauth/access_token");
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh-token");
      return mockJsonResponse({
        access_token: "new-user-token",
        refresh_token: "new-refresh-token",
        expires_in: 28_800,
        scope: "",
      });
    }) as unknown as typeof fetch;

    const broker = createGitHubAppBroker(
      TEST_OAUTH_MANIFEST,
      TEST_CREDENTIALS,
      { userTokenStore: store },
    );
    const lease = await broker.issue({
      context: USER_CREDENTIAL_CONTEXT,
      intent: "write",
      reason: "test:refresh-user-token",
    });

    expect(store.set).toHaveBeenCalledWith(
      "U123",
      "github",
      expect.objectContaining({
        accessToken: "new-user-token",
        refreshToken: "new-refresh-token",
      }),
    );
    expect(lease.headerTransforms?.[0]).toEqual({
      domain: "api.github.com",
      headers: { Authorization: "Bearer new-user-token" },
    });
  });
});
