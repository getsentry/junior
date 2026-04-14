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
  apiDomains: ["api.github.com"],
  authTokenEnv: "GITHUB_TOKEN",
  appIdEnv: "GITHUB_APP_ID",
  privateKeyEnv: "GITHUB_APP_PRIVATE_KEY",
  installationIdEnv: "GITHUB_INSTALLATION_ID",
};

const TEST_MANIFEST: PluginManifest = {
  name: "github",
  description: "GitHub issue management via GitHub App",
  capabilities: [
    "github.issues.read",
    "github.issues.write",
    "github.contents.read",
    "github.contents.write",
    "github.pull-requests.read",
    "github.pull-requests.write",
  ],
  configKeys: ["github.repo"],
  credentials: TEST_CREDENTIALS,
  target: { type: "repo", configKey: "github.repo" },
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
  it("issues lease with correct shape", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "issued-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.issues.write",
      reason: "test:lease-shape",
    });

    expect(lease.provider).toBe("github");
    expect(lease.env).toEqual({ GITHUB_TOKEN: "ghp_host_managed_credential" });
    expect(lease.headerTransforms).toEqual([
      {
        domain: "api.github.com",
        headers: { Authorization: "Bearer issued-token" },
      },
    ]);
  });

  it("uses placeholder in env, not real token", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "real-secret-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.issues.read",
      reason: "test:placeholder",
    });

    expect(lease.env.GITHUB_TOKEN).toBe("ghp_host_managed_credential");
    expect(lease.env.GITHUB_TOKEN).not.toBe("real-secret-token");
  });

  it("uses configured auth token placeholder when provided by plugin config", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "real-secret-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, {
      ...TEST_CREDENTIALS,
      authTokenPlaceholder: "github_host_managed_credential",
    });
    const lease = await broker.issue({
      capability: "github.issues.read",
      reason: "test:custom-placeholder",
    });

    expect(lease.env.GITHUB_TOKEN).toBe("github_host_managed_credential");
    expect(lease.env.GITHUB_TOKEN).not.toBe("real-secret-token");
  });

  it("scopes token to repository when target is provided", async () => {
    setupValidEnv();
    mockGitHubApi();

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.issues.write",
      target: { owner: "getsentry", repo: "junior" },
      reason: "test:scoped",
    });

    expect(lease.metadata).toMatchObject({ targetScope: "getsentry/junior" });
  });

  it("uses cached lease without recreating app jwt", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "cached-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const firstLease = await broker.issue({
      capability: "github.issues.write",
      reason: "test:cache-prime",
    });

    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;

    const secondLease = await broker.issue({
      capability: "github.issues.write",
      reason: "test:cache-hit",
    });

    expect(secondLease.headerTransforms).toEqual(firstLease.headerTransforms);
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(1);
  });

  it("maps issues.write to GitHub issues write permission", async () => {
    setupValidEnv();
    mockGitHubApi();

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await broker.issue({
      capability: "github.issues.write",
      reason: "test:issues-write",
    });

    const fetchCall = findAccessTokenCall();
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.permissions).toEqual({ issues: "write" });
  });

  it("rejects unsupported capabilities", async () => {
    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await expect(
      broker.issue({
        capability: "github.nonexistent-scope.write",
        reason: "test:unsupported",
      }),
    ).rejects.toThrow(
      "Unsupported github capability: github.nonexistent-scope.write",
    );
  });

  it("requires GITHUB_APP_ID", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    process.env.GITHUB_INSTALLATION_ID = "42";
    delete process.env.GITHUB_APP_ID;

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await expect(
      broker.issue({
        capability: "github.issues.read",
        reason: "test:missing-app-id",
      }),
    ).rejects.toThrow("Missing GITHUB_APP_ID");
  });

  it("requires GITHUB_INSTALLATION_ID", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    delete process.env.GITHUB_INSTALLATION_ID;

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await expect(
      broker.issue({
        capability: "github.issues.read",
        reason: "test:missing-installation-id",
      }),
    ).rejects.toThrow("Missing GITHUB_INSTALLATION_ID");
  });

  it("maps contents.read to GitHub contents permission", async () => {
    setupValidEnv();
    mockGitHubApi();

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await broker.issue({
      capability: "github.contents.read",
      target: { owner: "getsentry", repo: "sentry" },
      reason: "test:contents-read",
    });

    const fetchCall = findAccessTokenCall();
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.permissions).toEqual({ contents: "read" });
  });

  it("includes github.com in headerTransforms for contents.read", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "repo-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.contents.read",
      target: { owner: "getsentry", repo: "sentry" },
      reason: "test:contents-read-domains",
    });

    const domains = lease.headerTransforms!.map((t) => t.domain);
    expect(domains).toContain("api.github.com");
    expect(domains).toContain("github.com");
  });

  it("uses Basic auth for github.com and Bearer for api.github.com", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "repo-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.contents.read",
      target: { owner: "getsentry", repo: "sentry" },
      reason: "test:auth-scheme",
    });

    const apiTransform = lease.headerTransforms!.find(
      (t) => t.domain === "api.github.com",
    );
    const gitTransform = lease.headerTransforms!.find(
      (t) => t.domain === "github.com",
    );

    expect(apiTransform!.headers.Authorization).toBe("Bearer repo-token");
    expect(gitTransform!.headers.Authorization).toBe(
      `Basic ${Buffer.from("x-access-token:repo-token").toString("base64")}`,
    );
  });

  it("uses placeholder in env for contents.read", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "repo-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.contents.read",
      target: { owner: "getsentry", repo: "sentry" },
      reason: "test:contents-read-env",
    });

    expect(lease.env.GITHUB_TOKEN).toBe("ghp_host_managed_credential");
  });

  it("maps contents.write to GitHub contents write permission with git domain", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "push-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.contents.write",
      target: { owner: "getsentry", repo: "sentry" },
      reason: "test:contents-write",
    });

    const fetchCall = findAccessTokenCall();
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.permissions).toEqual({ contents: "write" });

    const domains = lease.headerTransforms!.map((t) => t.domain);
    expect(domains).toContain("github.com");
    expect(lease.env.GITHUB_TOKEN).toBe("ghp_host_managed_credential");
  });

  it("maps pull-requests.read to GitHub pull_requests read permission", async () => {
    setupValidEnv();
    mockGitHubApi();

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.pull-requests.read",
      reason: "test:pr-read",
    });

    const fetchCall = findAccessTokenCall();
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.permissions).toEqual({ pull_requests: "read" });

    const domains = lease.headerTransforms!.map((t) => t.domain);
    expect(domains).toEqual(["api.github.com"]);
  });

  it("maps pull-requests.write to GitHub pull_requests write permission", async () => {
    setupValidEnv();
    mockGitHubApi();

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await broker.issue({
      capability: "github.pull-requests.write",
      reason: "test:pr-write",
    });

    const fetchCall = findAccessTokenCall();
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.permissions).toEqual({ pull_requests: "write" });
  });

  it("does not include github.com in headerTransforms for issue capabilities", async () => {
    setupValidEnv();
    mockGitHubApi({ token: "issue-token" });

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.issues.read",
      reason: "test:no-git-domain",
    });

    const domains = lease.headerTransforms!.map((t) => t.domain);
    expect(domains).toEqual(["api.github.com"]);
    expect(domains).not.toContain("github.com");
  });

  it("fails with clear error when private key is malformed", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "not-a-real-private-key";
    process.env.GITHUB_INSTALLATION_ID = "42";

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await expect(
      broker.issue({
        capability: "github.issues.read",
        reason: "test:bad-key",
      }),
    ).rejects.toThrow("Invalid GITHUB_APP_PRIVATE_KEY");
  });
});
