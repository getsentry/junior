import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueProviderCredentialLease } from "@/chat/capabilities/factory";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { stubTestEnv } from "../../fixtures/vitest";

const USER_CREDENTIAL_CONTEXT = {
  actor: { type: "user" as const, userId: "U123" },
};

describe("capability factory", () => {
  beforeEach(async () => {
    stubTestEnv({ JUNIOR_STATE_ADAPTER: "memory" });
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    setPluginCatalogConfig(undefined);
    await disconnectStateAdapter();
    vi.unstubAllEnvs();
  });

  it("issues provider credential leases through the registered plugin broker", async () => {
    stubTestEnv({ EXAMPLE_API_HEADER: "secret-header" });
    setPluginCatalogConfig({
      inlineManifests: [
        {
          manifest: {
            name: "example",
            description: "Example",
            capabilities: ["example.api"],
            configKeys: [],
            domains: ["api.example.com"],
            envVars: {
              EXAMPLE_API_HEADER: {},
            },
            apiHeaders: {
              Authorization: "Bearer ${EXAMPLE_API_HEADER}",
              "X-Api-Version": "2026-01-01",
            },
            commandEnv: {
              EXAMPLE_API_KEY: "host_managed_credential",
            },
          },
        },
      ],
    });

    const lease = await issueProviderCredentialLease({
      context: USER_CREDENTIAL_CONTEXT,
      provider: "example",
      reason: "test:api-headers",
    });

    expect(lease).toMatchObject({
      provider: "example",
      env: {
        EXAMPLE_API_KEY: "host_managed_credential",
      },
      headerTransforms: [
        {
          domain: "api.example.com",
          headers: {
            Authorization: "Bearer secret-header",
            "X-Api-Version": "2026-01-01",
          },
        },
      ],
      metadata: {
        reason: "test:api-headers",
      },
    });
  });

  it("skips domain-only providers in the generic credential router", async () => {
    setPluginCatalogConfig({
      inlineManifests: [
        {
          manifest: {
            name: "github",
            description: "GitHub",
            capabilities: ["github.api"],
            configKeys: [],
            domains: ["api.github.com"],
          },
        },
        {
          manifest: {
            name: "sentry",
            description: "Sentry",
            capabilities: ["sentry.api"],
            configKeys: [],
            credentials: {
              type: "oauth-bearer",
              domains: ["sentry.io"],
              authTokenEnv: "SENTRY_AUTH_TOKEN",
            },
          },
        },
      ],
    });

    await expect(
      issueProviderCredentialLease({
        context: USER_CREDENTIAL_CONTEXT,
        provider: "github",
        reason: "test:domain-only",
      }),
    ).rejects.toThrow("No credential broker registered for provider: github");
  });
});
