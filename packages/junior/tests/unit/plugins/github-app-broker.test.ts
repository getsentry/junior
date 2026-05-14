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
  capabilities: [
    "github.actions.read",
    "github.actions.write",
    "github.issues.read",
    "github.issues.write",
    "github.contents.read",
    "github.contents.write",
    "github.pull-requests.read",
    "github.pull-requests.write",
  ],
  configKeys: ["github.org", "github.repo"],
  credentials: TEST_CREDENTIALS,
  target: {
    type: "repo",
    configKey: "github.repo",
    commandFlags: ["--repo", "-R"],
  },
};

const TEST_GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "sentry-junior[bot]",
  GIT_AUTHOR_EMAIL: "264270552+sentry-junior[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "sentry-junior[bot]",
  GIT_COMMITTER_EMAIL: "264270552+sentry-junior[bot]@users.noreply.github.com",
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
  appSlug?: string;
  botId?: number;
  onRequest?: (url: string, init?: RequestInit) => void;
}) {
  const token = options?.token ?? "issued-token";
  const appSlug = options?.appSlug ?? "sentry-junior";
  const botId = options?.botId ?? 264270552;
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
    if (url.endsWith("/app")) {
      return mockJsonResponse({ slug: appSlug });
    }
    if (url.endsWith(`/users/${encodeURIComponent(`${appSlug}[bot]`)}`)) {
      return mockJsonResponse({ id: botId });
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
      ...TEST_GIT_IDENTITY_ENV,
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
    expect(
      vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url)),
    ).toEqual(
      expect.arrayContaining([
        "https://api.github.com/app",
        "https://api.github.com/users/sentry-junior%5Bbot%5D",
      ]),
    );
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

  it("reuses cached leases for the same installation", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "cached-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const firstLease = await broker.issue({
      reason: "test:cache-prime",
    });

    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;

    const secondLease = await broker.issue({
      reason: "test:cache-hit",
    });

    expect(secondLease.headerTransforms).toEqual(firstLease.headerTransforms);
    const accessTokenCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).includes("/access_tokens"));
    expect(accessTokenCalls).toHaveLength(1);
  });

  it("requests the full plugin permission set when minting installation tokens", async () => {
    setupValidEnv();
    mockGitHubApi();

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await broker.issue({
      reason: "test:permissions",
    });

    const fetchCall = findAccessTokenCall();
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.permissions).toEqual({
      issues: "write",
      contents: "write",
      actions: "write",
      pull_requests: "write",
    });
    expect(body.repositories).toBeUndefined();
  });
});
