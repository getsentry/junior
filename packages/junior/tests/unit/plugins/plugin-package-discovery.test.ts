import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginPackageApp,
  pluginSkillRoot,
  resetPluginPackageRegistryState,
  setPluginCatalogConfigForTest,
} from "../../fixtures/plugin-packages";

afterEach(() => {
  resetPluginPackageRegistryState();
});

describe("plugin package discovery", () => {
  it("loads plugins from installed npm dependencies", async () => {
    const app = await createPluginPackageApp([
      {
        packageName: "junior-plugin-demo",
        manifest: [
          "name: demo",
          "description: Demo plugin",
          "capabilities:",
          "  - api",
          "config-keys:",
          "  - org",
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - api.example.com",
          "  auth-token-env: DEMO_AUTH_TOKEN",
        ],
      },
    ]);

    const registry = await import("@/chat/plugins/registry");
    const providers = registry.getPluginProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.manifest.name).toBe("demo");
    expect(providers[0]?.manifest.capabilities).toEqual(["demo.api"]);
    expect(registry.getPluginSkillRoots()).toEqual([
      pluginSkillRoot(app, "junior-plugin-demo"),
    ]);
    expect(registry.isPluginProvider("demo")).toBe(true);
  });

  it("loads bundle-only plugins without capability or credential fields", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-bundle-only",
        manifest: ["name: demo", "description: Demo bundle-only plugin"],
      },
    ]);

    const registry = await import("@/chat/plugins/registry");
    const providers = registry.getPluginProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.manifest.name).toBe("demo");
    expect(providers[0]?.manifest.capabilities).toEqual([]);
    expect(providers[0]?.manifest.configKeys).toEqual([]);
    expect(providers[0]?.manifest.credentials).toBeUndefined();
    expect(() =>
      registry.createPluginBroker("demo", {
        userTokenStore: {
          get: async () => undefined,
          set: async () => {},
          delete: async () => {},
        },
      }),
    ).toThrow('Provider "demo" has no credentials or API headers configured');
  });

  it("applies manifest overrides before duplicate domain validation", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-alpha",
        skillName: "alpha",
        manifest: [
          "name: alpha",
          "description: alpha plugin",
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - api.example.com",
          "  auth-token-env: ALPHA_AUTH_TOKEN",
        ],
      },
      {
        packageName: "junior-plugin-beta",
        skillName: "beta",
        manifest: [
          "name: beta",
          "description: beta plugin",
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - api.example.com",
          "  auth-token-env: BETA_AUTH_TOKEN",
        ],
      },
    ]);
    await setPluginCatalogConfigForTest({
      manifests: {
        beta: {
          credentials: {
            domains: ["beta.example.com"],
          },
        },
      },
    });

    const registry = await import("@/chat/plugins/registry");
    expect(
      registry.getPluginProviders().map((plugin) => ({
        name: plugin.manifest.name,
        domains: plugin.manifest.credentials?.domains,
      })),
    ).toEqual([
      { name: "alpha", domains: ["api.example.com"] },
      { name: "beta", domains: ["beta.example.com"] },
    ]);
  });
});
