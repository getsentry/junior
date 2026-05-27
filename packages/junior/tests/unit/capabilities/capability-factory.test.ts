import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginDefinition } from "@/chat/plugins/types";

const createPluginBrokerMock = vi.fn();
const getPluginProvidersMock = vi.fn<() => PluginDefinition[]>();

vi.mock("@/chat/capabilities/catalog", () => ({
  logCapabilityCatalogLoadedOnce: vi.fn(),
}));

vi.mock("@/chat/plugins/registry", () => ({
  createPluginBroker: (...args: unknown[]) => createPluginBrokerMock(...args),
  getPluginDefinition: (provider: string) =>
    getPluginProvidersMock().find(
      (plugin) => plugin.manifest.name === provider,
    ),
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
      provider: "example",
      requesterId: "U123",
      reason: "test:api-headers",
    });

    expect(createPluginBrokerMock).toHaveBeenCalledWith("example", {
      userTokenStore: expect.any(Object),
    });
    expect(broker.issue).toHaveBeenCalledWith({
      requesterId: "U123",
      reason: "test:api-headers",
    });
    expect(lease.provider).toBe("example");
  });
});
