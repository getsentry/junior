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
    delete process.env.EVAL_ENABLE_TEST_CREDENTIALS;
    createPluginBrokerMock.mockReset();
    getPluginProvidersMock.mockReset();
    vi.resetModules();
  });

  it("uses test header transforms for header-only plugins in eval mode", async () => {
    process.env.EVAL_ENABLE_TEST_CREDENTIALS = "1";
    createPluginBrokerMock.mockImplementation(() => {
      throw new Error("should not create real plugin broker");
    });
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

    expect(createPluginBrokerMock).not.toHaveBeenCalled();
    expect(lease.env).toEqual({
      EXAMPLE_API_KEY: "host_managed_credential",
    });
    expect(lease.headerTransforms).toEqual([
      {
        domain: "api.example.com",
        headers: {
          Authorization: "Bearer eval-test-example-api-header",
          "X-Api-Version": "2026-01-01",
        },
      },
    ]);
  });
});
