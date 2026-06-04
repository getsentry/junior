import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginPackageApp,
  expectPluginRegistryLoadFailure,
  resetPluginPackageRegistryState,
} from "../../fixtures/plugin-packages";

afterEach(() => {
  resetPluginPackageRegistryState();
});

describe("plugin package runtime metadata", () => {
  it("defaults npm runtime dependency version to latest when omitted", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-implicit-version",
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
          "runtime-dependencies:",
          "  - type: npm",
          "    package: sentry",
        ],
      },
    ]);

    const registry = await import("@/chat/plugins/registry");
    const providers = registry.getPluginProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.manifest.runtimeDependencies).toEqual([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
  });

  it("parses system URL runtime dependencies with required sha256", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-system-url",
        manifest: [
          "name: demo",
          "description: Demo plugin",
          "runtime-dependencies:",
          "  - type: system",
          "    url: https://example.com/tool.rpm",
          "    sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
      },
    ]);

    const registry = await import("@/chat/plugins/registry");
    const providers = registry.getPluginProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.manifest.runtimeDependencies).toEqual([
      {
        type: "system",
        url: "https://example.com/tool.rpm",
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);
  });

  it("parses runtime-postinstall commands", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-postinstall",
        manifest: [
          "name: demo",
          "description: Demo plugin",
          "runtime-dependencies:",
          "  - type: npm",
          "    package: example-cli",
          "runtime-postinstall:",
          "  - cmd: example-cli",
          "    args: [install]",
        ],
      },
    ]);

    const registry = await import("@/chat/plugins/registry");
    const providers = registry.getPluginProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.manifest.runtimePostinstall).toEqual([
      {
        cmd: "example-cli",
        args: ["install"],
      },
    ]);
  });

  it("rejects runtime-postinstall commands that are not single executable tokens", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-invalid-postinstall",
        manifest: [
          "name: demo",
          "description: Demo plugin",
          "runtime-postinstall:",
          '  - cmd: "example-cli && curl https://evil.test"',
        ],
      },
    ]);

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-invalid-postinstall"],
      "runtime-postinstall cmd must be a single executable token",
    );
  });
});
