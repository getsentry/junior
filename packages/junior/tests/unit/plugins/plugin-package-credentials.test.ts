import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginPackageApp,
  expectPluginRegistryLoadFailure,
  resetPluginPackageRegistryState,
  setPluginCatalogConfigForTest,
} from "../../fixtures/plugin-packages";

afterEach(() => {
  resetPluginPackageRegistryState();
});

describe("plugin package credentials", () => {
  it("parses optional oauth overrides and api headers from packaged plugins", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-oauth-overrides",
        manifest: [
          "name: example",
          "description: Example plugin",
          "capabilities:",
          "  - api.read",
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - api.example.com",
          "  api-headers:",
          '    X-Api-Version: "2026-01-01"',
          "  auth-token-env: EXAMPLE_TOKEN",
          "oauth:",
          "  client-id-env: EXAMPLE_CLIENT_ID",
          "  client-secret-env: EXAMPLE_CLIENT_SECRET",
          "  authorize-endpoint: https://api.example.com/v1/oauth/authorize",
          "  token-endpoint: https://api.example.com/v1/oauth/token",
          "  scope: api.read",
          "  authorize-params:",
          "    audience: workspace",
          "  token-auth-method: basic",
          "  token-extra-headers:",
          "    Content-Type: application/json",
        ],
      },
    ]);

    const registry = await import("@/chat/plugins/registry");
    const provider = registry.getPluginProviders()[0];
    expect(provider?.manifest.credentials).toMatchObject({
      type: "oauth-bearer",
      apiHeaders: {
        "X-Api-Version": "2026-01-01",
      },
    });
    expect(provider?.manifest.oauth).toMatchObject({
      authorizeParams: {
        audience: "workspace",
      },
      tokenAuthMethod: "basic",
      tokenExtraHeaders: {
        "Content-Type": "application/json",
      },
    });
    expect(registry.getPluginOAuthConfig("example")).toMatchObject({
      authorizeParams: {
        audience: "workspace",
      },
      tokenAuthMethod: "basic",
      tokenExtraHeaders: {
        "Content-Type": "application/json",
      },
    });
  });

  it("rejects credentials with invalid domains values", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-invalid-domain",
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
          "    - '*'",
          "  auth-token-env: DEMO_AUTH_TOKEN",
        ],
      },
    ]);

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-invalid-domain"],
      "credentials.domains entries must be valid domain names",
    );
  });

  it("rejects provider domains claimed by multiple plugins", async () => {
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

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-alpha", "@acme/junior-plugin-beta"],
      'Duplicate provider domain "api.example.com" in plugin "beta" already declared by plugin "alpha"',
    );
  });

  it("rejects duplicate plugin names", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-first",
        manifest: [
          "name: demo",
          "description: Demo plugin",
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - junior-plugin-first.example.com",
          "  auth-token-env: DEMO_AUTH_TOKEN",
        ],
      },
      {
        packageName: "junior-plugin-second",
        manifest: [
          "name: demo",
          "description: Demo plugin",
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - junior-plugin-second.example.com",
          "  auth-token-env: DEMO_AUTH_TOKEN",
        ],
      },
    ]);

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-first", "@acme/junior-plugin-second"],
      'Duplicate plugin name "demo"',
    );
  });

  it("rejects manifest overrides for missing plugins", async () => {
    await createPluginPackageApp([
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
    await setPluginCatalogConfigForTest({
      manifests: {
        missing: {
          description: "Typo",
        },
      },
    });

    const registry = await import("@/chat/plugins/registry");
    expect(() => registry.getPluginProviders()).toThrow(
      "plugins.manifests.missing does not match a loaded plugin",
    );
  });

  it("rejects credentials with invalid auth-token-env values", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-invalid-auth-env",
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
          "  auth-token-env: demo_token",
        ],
      },
    ]);

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-invalid-auth-env"],
      "auth-token-env must be an uppercase env var name",
    );
  });

  it("rejects oauth endpoints that are not https URLs", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-invalid-oauth",
        manifest: [
          "name: demo",
          "description: Demo plugin",
          "capabilities:",
          "  - api",
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - api.example.com",
          "  auth-token-env: DEMO_AUTH_TOKEN",
          "oauth:",
          "  client-id-env: DEMO_CLIENT_ID",
          "  client-secret-env: DEMO_CLIENT_SECRET",
          "  authorize-endpoint: http://example.com/oauth/authorize",
          "  token-endpoint: https://example.com/oauth/token",
          "  scope: event:read",
        ],
      },
    ]);

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-invalid-oauth"],
      "oauth.authorize-endpoint must use https",
    );
  });

  it("rejects Authorization in credential api headers", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-bad-api-headers",
        manifest: [
          "name: demo",
          "description: Demo plugin",
          "capabilities:",
          "  - api",
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - api.example.com",
          "  api-headers:",
          "    Authorization: Bearer nope",
          "  auth-token-env: DEMO_AUTH_TOKEN",
        ],
      },
    ]);

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-bad-api-headers"],
      "Plugin demo credentials.api-headers.Authorization is not allowed",
    );
  });
});
