import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GitHubCredentialBroker } from "@/chat/credentials/github-broker";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("github credential broker", () => {
  it("accepts base64-encoded PEM private key for app signing", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(privateKey, "utf8").toString("base64");
    process.env.GITHUB_INSTALLATION_ID = "42";

    const fetchSpy = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: "issued-token", expires_at: "2099-01-01T00:00:00Z" })
      } as Response;
    });
    globalThis.fetch = fetchSpy as typeof fetch;
    const broker = new GitHubCredentialBroker();
    const lease = await broker.issue({
      capability: "github.issues.write",
      reason: "test:base64-key"
    });

    expect(lease.provider).toBe("github");
    expect(lease.env).toEqual({ GITHUB_TOKEN: "issued-token" });
    expect(lease.headerTransforms).toEqual([
      {
        domain: "api.github.com",
        headers: {
          Authorization: "Bearer issued-token"
        }
      }
    ]);
    expect(lease.metadata).toMatchObject({
      installationId: "42",
      targetScope: "all"
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calls = (fetchSpy as unknown as { mock: { calls: Array<[unknown, RequestInit?]> } }).mock.calls;
    const requestInit = calls[0]?.[1];
    expect(requestInit).toBeDefined();
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.body).toBe(
      JSON.stringify({
        permissions: { issues: "write" }
      })
    );
  });

  it("requests repository-scoped token when a target is provided", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(privateKey, "utf8").toString("base64");
    process.env.GITHUB_INSTALLATION_ID = "42";

    const fetchSpy = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: "issued-token", expires_at: "2099-01-01T00:00:00Z" })
      } as Response;
    });
    globalThis.fetch = fetchSpy as typeof fetch;
    const broker = new GitHubCredentialBroker();
    await broker.issue({
      capability: "github.issues.write",
      target: { owner: "getsentry", repo: "junior" },
      reason: "test:scoped"
    });

    const calls = (fetchSpy as unknown as { mock: { calls: Array<[unknown, RequestInit?]> } }).mock.calls;
    const requestInit = calls[0]?.[1];
    expect(requestInit?.body).toBe(
      JSON.stringify({
        permissions: { issues: "write" },
        repositories: ["junior"]
      })
    );
  });

  it("does not reuse cached tokens across repository targets", async () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(privateKey, "utf8").toString("base64");
    process.env.GITHUB_INSTALLATION_ID = "42";

    let issueCount = 0;
    const fetchSpy = vi.fn(async () => {
      issueCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            token: `issued-token-${issueCount}`,
            expires_at: "2099-01-01T00:00:00Z"
          })
      } as Response;
    });
    globalThis.fetch = fetchSpy as typeof fetch;
    const broker = new GitHubCredentialBroker();

    const first = await broker.issue({
      capability: "github.issues.write",
      target: { owner: "getsentry", repo: "junior" },
      reason: "test:cache:first"
    });
    const second = await broker.issue({
      capability: "github.issues.write",
      target: { owner: "getsentry", repo: "other-repo" },
      reason: "test:cache:second"
    });

    expect(first.env.GITHUB_TOKEN).not.toBe(second.env.GITHUB_TOKEN);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("still rejects unsupported capabilities", async () => {
    process.env.GITHUB_APP_ID = "12345";

    const broker = new GitHubCredentialBroker();
    await expect(
      broker.issue({
        capability: "github.actions.write",
        reason: "test:unsupported"
      })
    ).rejects.toThrow("Unsupported GitHub capability: github.actions.write");
  });

  it("requires GITHUB_APP_ID", async () => {
    delete process.env.GITHUB_APP_ID;

    const broker = new GitHubCredentialBroker();
    await expect(
      broker.issue({
        capability: "github.issues.read",
        reason: "test:missing-app-id"
      })
    ).rejects.toThrow("Missing GITHUB_APP_ID");
  });

  it("requires GITHUB_INSTALLATION_ID", async () => {
    process.env.GITHUB_APP_ID = "12345";
    delete process.env.GITHUB_INSTALLATION_ID;

    const broker = new GitHubCredentialBroker();
    await expect(
      broker.issue({
        capability: "github.issues.read",
        reason: "test:missing-installation-id"
      })
    ).rejects.toThrow("Missing GITHUB_INSTALLATION_ID");
  });

  it("fails with clear error when private key is malformed", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "not-a-real-private-key";
    process.env.GITHUB_INSTALLATION_ID = "42";
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const broker = new GitHubCredentialBroker();
    await expect(
      broker.issue({
        capability: "github.issues.read",
        reason: "test:bad-key"
      })
    ).rejects.toThrow("Invalid GITHUB_APP_PRIVATE_KEY");
  });
});
