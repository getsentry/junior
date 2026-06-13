import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSandboxEgressNetworkPolicy,
  cleanupSandboxEgressProxyTest,
  configureSandboxEgressPlugins,
  createSandboxEgressCredentialToken,
  EGRESS_ID,
  githubPlugin,
  headerOnlyPlugin,
  matchesSandboxEgressDomain,
  REQUESTER_ID,
  resolveSandboxCommandEnvironment,
  setupSandboxEgressProxyTest,
  sentryPlugin,
} from "../../fixtures/sandbox/egress-proxy";

describe("sandbox egress policy", () => {
  beforeEach(async () => {
    await setupSandboxEgressProxyTest();
  });

  afterEach(async () => {
    await cleanupSandboxEgressProxyTest();
  });

  it("builds provider forwarding policy for sandbox egress", () => {
    expect(matchesSandboxEgressDomain("SENTRY.IO", "sentry.io")).toBe(true);
    expect(matchesSandboxEgressDomain("eu.sentry.io", "sentry.io")).toBe(false);
    expect(buildSandboxEgressNetworkPolicy()).toEqual({
      allow: {
        "*": [],
      },
    });

    const token = createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    expect(
      buildSandboxEgressNetworkPolicy({ credentialToken: token }),
    ).toMatchObject({
      allow: {
        "sentry.io": [
          {
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${token}`,
          },
        ],
        "us.sentry.io": [
          {
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${token}`,
          },
        ],
      },
    });
  });

  it("adds trace propagation transforms only for configured domains", () => {
    configureSandboxEgressPlugins([sentryPlugin(), githubPlugin()]);

    expect(
      buildSandboxEgressNetworkPolicy({
        traceConfig: { domains: ["*.sentry.io"] },
        traceHeaders: {
          "sentry-trace": "trace-span-1",
          baggage: "sentry-release=abc",
          traceparent: "00-trace-span-01",
        },
      }),
    ).toMatchObject({
      allow: {
        "*.sentry.io": [
          {
            transform: [
              {
                headers: {
                  "sentry-trace": "trace-span-1",
                  baggage: "sentry-release=abc",
                  traceparent: "00-trace-span-01",
                },
              },
            ],
          },
        ],
      },
    });
  });

  it("adds trace-only domains without provider forwarding", () => {
    configureSandboxEgressPlugins([sentryPlugin()]);

    expect(
      buildSandboxEgressNetworkPolicy({
        traceConfig: { domains: ["*.sentry.io"] },
        traceHeaders: {
          "sentry-trace": "trace-span-1",
        },
      }),
    ).toEqual({
      allow: {
        "*": [],
        "*.sentry.io": [
          {
            transform: [
              {
                headers: {
                  "sentry-trace": "trace-span-1",
                },
              },
            ],
          },
        ],
      },
    });
  });

  it("fails sandbox egress policy setup without a public callback URL", () => {
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_SECRET;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;

    expect(() =>
      buildSandboxEgressNetworkPolicy({ credentialToken: "token" }),
    ).toThrow("Cannot determine base URL for sandbox credential egress");
  });

  it("does not reuse Slack signing secret for sandbox egress tokens", () => {
    delete process.env.JUNIOR_SECRET;
    process.env.SLACK_SIGNING_SECRET = "test-slack-signing-secret";

    expect(() =>
      createSandboxEgressCredentialToken({
        credentials: { actor: { type: "user", userId: REQUESTER_ID } },
        egressId: EGRESS_ID,
        ttlMs: 60_000,
      }),
    ).toThrow("Cannot determine sandbox egress secret (set JUNIOR_SECRET)");
  });

  it("resolves command env for registered sandbox providers", async () => {
    await expect(resolveSandboxCommandEnvironment()).resolves.toEqual({
      SENTRY_READ_ONLY: "1",
      SENTRY_AUTH_TOKEN: "host_managed_credential",
    });
  });

  it("resolves command env for every registered sandbox provider", async () => {
    configureSandboxEgressPlugins([githubPlugin(), sentryPlugin()]);

    await expect(resolveSandboxCommandEnvironment()).resolves.toEqual({
      GITHUB_READ_ONLY: "1",
      GITHUB_TOKEN: "ghp_host_managed_credential",
      SENTRY_READ_ONLY: "1",
      SENTRY_AUTH_TOKEN: "host_managed_credential",
    });
  });

  it("does not invent token env placeholders for domain-only providers", async () => {
    configureSandboxEgressPlugins([headerOnlyPlugin()]);

    await expect(resolveSandboxCommandEnvironment()).resolves.toEqual({
      HEADER_ONLY_READ_ONLY: "1",
    });
  });

  it("resolves host env bindings for sandbox commands", async () => {
    process.env.SENTRY_BOT_EMAIL = "123+sentry[bot]@users.noreply.github.com";

    await expect(resolveSandboxCommandEnvironment()).resolves.toEqual({
      SENTRY_AUTHOR_EMAIL: "123+sentry[bot]@users.noreply.github.com",
      SENTRY_READ_ONLY: "1",
      SENTRY_AUTH_TOKEN: "host_managed_credential",
    });
  });
});
