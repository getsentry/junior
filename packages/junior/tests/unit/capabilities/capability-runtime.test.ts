import { describe, expect, it, vi } from "vitest";
import type { CredentialRouter } from "@/chat/capabilities/router";
import type { CredentialBroker } from "@/chat/credentials/broker";
import { CredentialUnavailableError } from "@/chat/credentials/broker";

vi.mock("@/chat/plugins/registry", () => ({
  getPluginDefinition: (provider: string) =>
    provider === "github"
      ? {
          manifest: {
            name: "github",
            description: "GitHub",
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
            credentials: {
              type: "github-app",
              apiDomains: ["api.github.com"],
              authTokenEnv: "GITHUB_TOKEN",
              appIdEnv: "GITHUB_APP_ID",
              privateKeyEnv: "GITHUB_APP_PRIVATE_KEY",
              installationIdEnv: "GITHUB_INSTALLATION_ID",
            },
            target: {
              type: "repo",
              configKey: "github.repo",
              commandFlags: ["--repo", "-R"],
            },
          },
        }
      : provider === "sentry"
        ? {
            manifest: {
              name: "sentry",
              description: "Sentry",
              capabilities: ["sentry.api"],
              configKeys: ["sentry.org", "sentry.project"],
              credentials: {
                type: "oauth-bearer",
                apiDomains: ["sentry.io"],
                authTokenEnv: "SENTRY_AUTH_TOKEN",
              },
            },
          }
        : provider === "example"
          ? {
              manifest: {
                name: "example",
                description: "Example",
                capabilities: ["example.api"],
                configKeys: [],
                apiDomains: ["api.example.com"],
                apiHeaders: {
                  "X-Api-Key": "${EXAMPLE_API_KEY}",
                },
              },
            }
          : undefined,
}));

import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";

describe("skill capability runtime", () => {
  it("issues turn-scoped transforms on first enable and reuses them within the turn", async () => {
    let issueCalls = 0;
    const broker: CredentialBroker = {
      issue: async () => {
        issueCalls += 1;
        return {
          id: "lease-1",
          provider: "sentry",
          env: { SENTRY_AUTH_TOKEN: "host_managed_credential" },
          headerTransforms: [
            {
              domain: "sentry.io",
              headers: {
                Authorization: "Bearer token-1",
              },
            },
          ],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };

    const runtime = new SkillCapabilityRuntime({
      broker,
      requesterId: "U123",
    });

    await expect(
      runtime.enableCredentialsForTurn({
        provider: "sentry",
        reason: "test:first",
      }),
    ).resolves.toMatchObject({ reused: false });
    expect(runtime.getTurnHeaderTransforms()).toEqual([
      {
        domain: "sentry.io",
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    ]);
    expect(runtime.getTurnEnv()).toEqual({
      SENTRY_AUTH_TOKEN: "host_managed_credential",
    });

    await expect(
      runtime.enableCredentialsForTurn({
        provider: "sentry",
        reason: "test:second",
      }),
    ).resolves.toMatchObject({ reused: true });
    expect(issueCalls).toBe(1);
  });

  it("reuses provider credentials within the same turn for GitHub", async () => {
    let issueCalls = 0;
    const broker: CredentialBroker = {
      issue: async () => {
        issueCalls += 1;
        return {
          id: `lease-${issueCalls}`,
          provider: "github",
          env: { GITHUB_TOKEN: "ghp_host_managed_credential" },
          headerTransforms: [
            {
              domain: "api.github.com",
              headers: {
                Authorization: `Bearer token-${issueCalls}`,
              },
            },
          ],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };

    const runtime = new SkillCapabilityRuntime({
      broker,
      requesterId: "U123",
    });

    await expect(
      runtime.enableCredentialsForTurn({
        provider: "github",
        reason: "test:first",
      }),
    ).resolves.toMatchObject({ reused: false });
    await expect(
      runtime.enableCredentialsForTurn({
        provider: "github",
        reason: "test:second",
      }),
    ).resolves.toMatchObject({ reused: true });
    expect(issueCalls).toBe(1);
  });

  it("enables GitHub credentials without extra target plumbing", async () => {
    let seenReason: string | undefined;
    const broker: CredentialBroker = {
      issue: async (input) => {
        seenReason = input.reason;
        return {
          id: "lease-1",
          provider: "github",
          env: { GITHUB_TOKEN: "ghp_host_managed_credential" },
          headerTransforms: [
            {
              domain: "api.github.com",
              headers: {
                Authorization: "Bearer token-1",
              },
            },
          ],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };

    const runtime = new SkillCapabilityRuntime({
      broker,
      requesterId: "U123",
    });

    await expect(
      runtime.enableCredentialsForTurn({
        provider: "github",
        reason: "test:no-target",
      }),
    ).resolves.toMatchObject({ reused: false });

    expect(seenReason).toBe("test:no-target");
  });

  it("issues header transforms for plugins without credentials", async () => {
    let issueCalls = 0;
    const broker: CredentialBroker = {
      issue: async () => {
        issueCalls += 1;
        return {
          id: "lease-1",
          provider: "example",
          env: {},
          headerTransforms: [
            {
              domain: "api.example.com",
              headers: {
                "X-Api-Key": "secret",
              },
            },
          ],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };

    const runtime = new SkillCapabilityRuntime({
      broker,
      requesterId: "U123",
    });

    await expect(
      runtime.enableCredentialsForTurn({
        provider: "example",
        reason: "test:api-headers",
      }),
    ).resolves.toMatchObject({ reused: false });

    expect(issueCalls).toBe(1);
    expect(runtime.getTurnHeaderTransforms()).toEqual([
      {
        domain: "api.example.com",
        headers: {
          "X-Api-Key": "secret",
        },
      },
    ]);
  });

  it("enables command proxy credentials without an active skill", async () => {
    const router: CredentialRouter = {
      issue: async (input) => ({
        id: "lease-1",
        provider: input.provider,
        env: { GITHUB_TOKEN: "ghp_host_managed_credential" },
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: {
              Authorization: "Bearer token-1",
            },
          },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    };
    const runtime = new SkillCapabilityRuntime({
      router,
      requesterId: "U123",
    });

    await expect(
      runtime.enableCommandProxyCredentialsForTurn({
        providers: ["github"],
        reason: "sandbox:command-proxy",
      }),
    ).resolves.toEqual({
      activeProviders: ["github"],
      authRequiredProviders: [],
    });
    expect(runtime.getTurnEnv()).toEqual({
      GITHUB_TOKEN: "ghp_host_managed_credential",
    });
  });

  it("reports unavailable command proxy credentials without throwing", async () => {
    const router: CredentialRouter = {
      issue: async () => {
        throw new CredentialUnavailableError(
          "sentry",
          "No sentry credentials available",
        );
      },
    };
    const runtime = new SkillCapabilityRuntime({
      router,
      requesterId: "U123",
    });

    await expect(
      runtime.enableCommandProxyCredentialsForTurn({
        providers: ["sentry"],
        reason: "sandbox:command-proxy",
      }),
    ).resolves.toEqual({
      activeProviders: [],
      authRequiredProviders: ["sentry"],
    });
  });

  it("rethrows unexpected command proxy credential errors", async () => {
    const router: CredentialRouter = {
      issue: async () => {
        throw new Error("credential broker exploded");
      },
    };
    const runtime = new SkillCapabilityRuntime({
      router,
      requesterId: "U123",
    });

    await expect(
      runtime.enableCommandProxyCredentialsForTurn({
        providers: ["github"],
        reason: "sandbox:command-proxy",
      }),
    ).rejects.toThrow("credential broker exploded");
  });
});
