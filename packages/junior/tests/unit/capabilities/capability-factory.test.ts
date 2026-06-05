import { describe, expect, it, vi } from "vitest";
import type { StateAdapter } from "chat";
import { issueProviderCredentialLease } from "@/chat/capabilities/factory";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import type { PluginDefinition } from "@/chat/plugins/types";
import { DEFAULT_TEST_EXPIRES_AT_ISO } from "../../fixtures/vitest";

const USER_CREDENTIAL_CONTEXT = {
  actor: { type: "user" as const, userId: "U123" },
};

describe("capability factory", () => {
  it("uses normal plugin brokers for credential providers", async () => {
    const userTokenStore: UserTokenStore = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const stateAdapter = {} as StateAdapter;
    const broker: CredentialBroker = {
      issue: vi.fn(async () => ({
        id: "lease-1",
        provider: "example",
        env: {},
        expiresAt: DEFAULT_TEST_EXPIRES_AT_ISO,
      })),
    };
    const createPluginBroker = vi.fn(() => broker);
    const getPluginProviders = vi.fn((): PluginDefinition[] => [
      {
        manifest: {
          name: "example",
          displayName: "Example",
          description: "Example",
          capabilities: ["example.api"],
          configKeys: [],
          domains: ["api.example.com"],
          apiHeaders: {
            Authorization: "Bearer ${EXAMPLE_API_HEADER}",
            "X-Api-Version": "2026-01-01",
          },
          commandEnv: {
            EXAMPLE_API_KEY: "host_managed_credential",
          },
        },
        dir: "/tmp/example",
        skillsDir: "/tmp/example/skills",
      },
    ]);

    const lease = await issueProviderCredentialLease(
      {
        context: USER_CREDENTIAL_CONTEXT,
        provider: "example",
        reason: "test:api-headers",
      },
      {
        createPluginBroker,
        createUserTokenStoreForStateAdapter: () => userTokenStore,
        getPluginProviders,
        getStateAdapter: () => stateAdapter,
        logCapabilityCatalogLoadedOnce: vi.fn(),
        routerCache: new WeakMap(),
      },
    );

    expect(createPluginBroker).toHaveBeenCalledWith("example", {
      userTokenStore,
    });
    expect(broker.issue).toHaveBeenCalledWith({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:api-headers",
    });
    expect(lease.provider).toBe("example");
  });

  it("skips domain-only providers in the generic credential router", async () => {
    const broker = {
      issue: vi.fn(async () => ({
        id: "lease-1",
        provider: "sentry",
        env: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    };
    createPluginBrokerMock.mockReturnValue(broker);
    getPluginProvidersMock.mockReturnValue([
      {
        manifest: {
          name: "github",
          displayName: "GitHub",
          description: "GitHub",
          capabilities: ["github.api"],
          configKeys: [],
          domains: ["api.github.com"],
        },
        dir: "/tmp/github",
        skillsDir: "/tmp/github/skills",
      },
      {
        manifest: {
          name: "sentry",
          displayName: "Sentry",
          description: "Sentry",
          capabilities: ["sentry.api"],
          configKeys: [],
          credentials: {
            type: "oauth-bearer",
            domains: ["sentry.io"],
            authTokenEnv: "SENTRY_AUTH_TOKEN",
          },
        },
        dir: "/tmp/sentry",
        skillsDir: "/tmp/sentry/skills",
      },
    ]);

    const { issueProviderCredentialLease } =
      await import("@/chat/capabilities/factory");

    await issueProviderCredentialLease({
      context: USER_CREDENTIAL_CONTEXT,
      provider: "sentry",
      reason: "test:oauth",
    });

    expect(createPluginBrokerMock).toHaveBeenCalledTimes(1);
    expect(createPluginBrokerMock).toHaveBeenCalledWith("sentry", {
      userTokenStore: expect.any(Object),
    });
  });
});
