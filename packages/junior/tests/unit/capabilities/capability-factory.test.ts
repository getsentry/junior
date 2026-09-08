import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCatalogRuntime } from "@/chat/plugins/registry";
import type { PluginDefinition } from "@/chat/plugins/types";

const createBrokerMock = vi.fn<PluginCatalogRuntime["createBroker"]>();
const getProvidersMock = vi.fn<() => PluginDefinition[]>();
const USER_CREDENTIAL_CONTEXT = {
  actor: { type: "user" as const, userId: "U123" },
};

vi.mock("@/chat/capabilities/catalog", () => ({
  logCapabilityCatalogLoadedOnce: vi.fn(),
}));

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    createBroker: createBrokerMock,
    getProviders: () => getProvidersMock(),
  } satisfies Pick<PluginCatalogRuntime, "createBroker" | "getProviders">,
}));

const stateAdapter = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/chat/state/adapter", () => ({
  getStateAdapter: () => stateAdapter,
}));

const getWorkspaceTeamIdMock = vi.fn<() => string | undefined>(() => undefined);

vi.mock("@/chat/slack/workspace-context", () => ({
  getWorkspaceTeamId: () => getWorkspaceTeamIdMock(),
}));

describe("capability factory", () => {
  afterEach(() => {
    createBrokerMock.mockReset();
    getProvidersMock.mockReset();
    getWorkspaceTeamIdMock.mockReset();
    getWorkspaceTeamIdMock.mockReturnValue(undefined);
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
    createBrokerMock.mockReturnValue(broker);
    getProvidersMock.mockReturnValue([
      {
        manifest: {
          name: "example",
          displayName: "Example",
          description: "Example",
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

    expect(createBrokerMock).toHaveBeenCalledWith("example", {
      installationTokenStore: expect.any(Object),
      userTokenStore: expect.any(Object),
    });
    expect(broker.issue).toHaveBeenCalledWith({
      context: USER_CREDENTIAL_CONTEXT,
      reason: "test:api-headers",
    });
    expect(lease.provider).toBe("example");
  });

  it("scopes installation brokers from credential workspace id without ALS", async () => {
    const firstBroker = {
      issue: vi.fn(async () => ({
        id: "lease-1",
        provider: "linear",
        env: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    };
    const secondBroker = {
      issue: vi.fn(async () => ({
        id: "lease-2",
        provider: "linear",
        env: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    };
    createBrokerMock
      .mockReturnValueOnce(firstBroker)
      .mockReturnValueOnce(secondBroker);
    getProvidersMock.mockReturnValue([
      {
        manifest: {
          name: "linear",
          displayName: "Linear",
          description: "Linear",
          configKeys: [],
          credentials: {
            type: "oauth-bearer",
            domains: ["api.linear.app"],
            authTokenEnv: "LINEAR_ACCESS_TOKEN",
          },
        },
        dir: "/tmp/linear",
        skillsDir: "/tmp/linear/skills",
      },
    ]);

    const { issueProviderCredentialLease } =
      await import("@/chat/capabilities/factory");

    await issueProviderCredentialLease({
      context: {
        actor: { type: "user", userId: "U123" },
        workspaceId: "T111",
      },
      provider: "linear",
      reason: "test:workspace-a",
    });
    await issueProviderCredentialLease({
      context: {
        actor: { type: "user", userId: "U123" },
        workspaceId: "T222",
      },
      provider: "linear",
      reason: "test:workspace-b",
    });

    expect(createBrokerMock).toHaveBeenCalledTimes(2);
    expect(firstBroker.issue).toHaveBeenCalledTimes(1);
    expect(secondBroker.issue).toHaveBeenCalledTimes(1);
  });

  it("does not use ALS workspace when credential context omits workspaceId", async () => {
    const broker = {
      issue: vi.fn(async () => ({
        id: "lease-local",
        provider: "linear",
        env: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    };
    createBrokerMock.mockReturnValue(broker);
    getWorkspaceTeamIdMock.mockReturnValue("T-from-als");
    getProvidersMock.mockReturnValue([
      {
        manifest: {
          name: "linear",
          displayName: "Linear",
          description: "Linear",
          configKeys: [],
          credentials: {
            type: "oauth-bearer",
            domains: ["api.linear.app"],
            authTokenEnv: "LINEAR_ACCESS_TOKEN",
          },
        },
        dir: "/tmp/linear",
        skillsDir: "/tmp/linear/skills",
      },
    ]);

    const { issueProviderCredentialLease } =
      await import("@/chat/capabilities/factory");

    await issueProviderCredentialLease({
      context: {
        actor: { type: "user", userId: "U123" },
      },
      provider: "linear",
      reason: "test:missing-workspace",
    });

    expect(createBrokerMock).toHaveBeenCalledTimes(1);
    expect(createBrokerMock.mock.calls[0]?.[1]).toMatchObject({
      installationTokenStore: expect.any(Object),
      userTokenStore: expect.any(Object),
    });
    // Router must stay on the local slot so lease cache and token store match.
    await issueProviderCredentialLease({
      context: {
        actor: { type: "user", userId: "U123" },
      },
      provider: "linear",
      reason: "test:missing-workspace-again",
    });
    expect(createBrokerMock).toHaveBeenCalledTimes(1);
    expect(broker.issue).toHaveBeenCalledTimes(2);
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
    createBrokerMock.mockReturnValue(broker);
    getProvidersMock.mockReturnValue([
      {
        manifest: {
          name: "github",
          displayName: "GitHub",
          description: "GitHub",
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

    expect(createBrokerMock).toHaveBeenCalledTimes(1);
    expect(createBrokerMock).toHaveBeenCalledWith("sentry", {
      installationTokenStore: expect.any(Object),
      userTokenStore: expect.any(Object),
    });
  });
});
