import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createGitHubAppBroker } from "@/chat/plugins/auth/github-app-broker";
import type {
  GitHubAppCredentials,
  PluginManifest,
} from "@/chat/plugins/types";

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

function setupValidEnv() {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  process.env.GITHUB_INSTALLATION_ID = "42";
}

function mockJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

function mockGitHubApi(options?: {
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
      reason: "test:first-token",
    });
    const secondLease = await broker.issue({
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
      reason: "test:scoped-permissions",
    });

    const fetchCall = findAccessTokenCall();
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.permissions).toEqual({ issues: "write" });
  });
});
