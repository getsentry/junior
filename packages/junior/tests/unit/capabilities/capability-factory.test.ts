import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginDefinition } from "@/chat/plugins/types";

const createPluginBrokerMock = vi.fn();
const getPluginProvidersMock = vi.fn<() => PluginDefinition[]>();
const USER_CREDENTIAL_CONTEXT = {
  actor: { type: "user" as const, userId: "U123" },
};

vi.mock("@/chat/capabilities/catalog", () => ({
  logCapabilityCatalogLoadedOnce: vi.fn(),
}));

vi.mock("@/chat/plugins/registry", () => ({
  createPluginBroker: (...args: unknown[]) => createPluginBrokerMock(...args),
  getPluginProviders: () => getPluginProvidersMock(),
}));

vi.mock("@/chat/state/adapter", () => ({
  getStateAdapter: () => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));

describe("capability factory", () => {
  afterEach(() => {
    createPluginBrokerMock.mockReset();
    getPluginProvidersMock.mockReset();
    vi.resetModules();
  });

  it("uses normal plugin brokers for credential providers", async () => {
    const broker = {
      issue: vi.fn(async () => ({
        id: "lease-1",
        provider: "example",
        env: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    };
    createPluginBrokerMock.mockReturnValue(broker);
    getPluginProvidersMock.mockReturnValue([
      {
        manifest: {
          name: "example",
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

    const { issueProviderCredentialLease } =
      await import("@/chat/capabilities/factory");
    const lease = await issueProviderCredentialLease({
      context: USER_CREDENTIAL_CONTEXT,
      provider: "example",
      reason: "test:api-headers",
    });

    expect(createPluginBrokerMock).toHaveBeenCalledWith("example", {
      userTokenStore: expect.any(Object),
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
