import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createGitHubAppBroker } from "@/chat/plugins/github-app-broker";
import type { GitHubAppCredentials, PluginManifest } from "@/chat/plugins/types";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const TEST_CREDENTIALS: GitHubAppCredentials = {
  type: "github-app",
  apiDomains: ["api.github.com"],
  authTokenEnv: "GITHUB_TOKEN",
  appIdEnv: "GITHUB_APP_ID",
  privateKeyEnv: "GITHUB_APP_PRIVATE_KEY",
  installationIdEnv: "GITHUB_INSTALLATION_ID"
};

const TEST_MANIFEST: PluginManifest = {
  name: "github",
  description: "GitHub issue management via GitHub App",
  capabilities: ["github.issues.read", "github.issues.write", "github.issues.comment", "github.labels.write"],
  configKeys: ["github.repo"],
  credentials: TEST_CREDENTIALS,
  target: { type: "repo", configKey: "github.repo" }
};

function setupValidEnv() {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  process.env.GITHUB_INSTALLATION_ID = "42";
}

function mockGitHubTokenEndpoint(token = "issued-token") {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ token, expires_at: "2099-01-01T00:00:00Z" })
  })) as unknown as typeof fetch;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("github app credential broker", () => {
  it("issues lease with correct shape", async () => {
    setupValidEnv();
    mockGitHubTokenEndpoint("issued-token");

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.issues.write",
      reason: "test:lease-shape"
    });

    expect(lease.provider).toBe("github");
    expect(lease.env).toEqual({ GITHUB_TOKEN: "ghp_host_managed_credential" });
    expect(lease.headerTransforms).toEqual([
      { domain: "api.github.com", headers: { Authorization: "Bearer issued-token" } }
    ]);
  });

  it("uses placeholder in env, not real token", async () => {
    setupValidEnv();
    mockGitHubTokenEndpoint("real-secret-token");

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.issues.read",
      reason: "test:placeholder"
    });

    expect(lease.env.GITHUB_TOKEN).toBe("ghp_host_managed_credential");
    expect(lease.env.GITHUB_TOKEN).not.toBe("real-secret-token");
  });

  it("uses configured auth token placeholder when provided by plugin config", async () => {
    setupValidEnv();
    mockGitHubTokenEndpoint("real-secret-token");

    const broker = createGitHubAppBroker(TEST_MANIFEST, {
      ...TEST_CREDENTIALS,
      authTokenPlaceholder: "github_host_managed_credential"
    });
    const lease = await broker.issue({
      capability: "github.issues.read",
      reason: "test:custom-placeholder"
    });

    expect(lease.env.GITHUB_TOKEN).toBe("github_host_managed_credential");
    expect(lease.env.GITHUB_TOKEN).not.toBe("real-secret-token");
  });

  it("scopes token to repository when target is provided", async () => {
    setupValidEnv();
    mockGitHubTokenEndpoint();

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    const lease = await broker.issue({
      capability: "github.issues.write",
      target: { owner: "getsentry", repo: "junior" },
      reason: "test:scoped"
    });

    expect(lease.metadata).toMatchObject({ targetScope: "getsentry/junior" });
  });

  it("rejects unsupported capabilities", async () => {
    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await expect(
      broker.issue({ capability: "github.actions.write", reason: "test:unsupported" })
    ).rejects.toThrow("Unsupported GitHub capability: github.actions.write");
  });

  it("requires GITHUB_APP_ID", async () => {
    delete process.env.GITHUB_APP_ID;

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await expect(
      broker.issue({ capability: "github.issues.read", reason: "test:missing-app-id" })
    ).rejects.toThrow("Missing GITHUB_APP_ID");
  });

  it("requires GITHUB_INSTALLATION_ID", async () => {
    process.env.GITHUB_APP_ID = "12345";
    delete process.env.GITHUB_INSTALLATION_ID;

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await expect(
      broker.issue({ capability: "github.issues.read", reason: "test:missing-installation-id" })
    ).rejects.toThrow("Missing GITHUB_INSTALLATION_ID");
  });

  it("fails with clear error when private key is malformed", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "not-a-real-private-key";
    process.env.GITHUB_INSTALLATION_ID = "42";

    const broker = createGitHubAppBroker(TEST_MANIFEST, TEST_CREDENTIALS);
    await expect(
      broker.issue({ capability: "github.issues.read", reason: "test:bad-key" })
    ).rejects.toThrow("Invalid GITHUB_APP_PRIVATE_KEY");
  });
});
