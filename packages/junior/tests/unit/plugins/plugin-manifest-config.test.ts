import { describe, expect, it } from "vitest";
import { parseInlinePluginManifest, parsePluginManifest } from "@/chat/plugins/manifest";
import type { PluginManifest } from "@/chat/plugins/types";

describe("plugin manifest config", () => {
  it("applies manifest config before validation", () => {
    const manifest = parsePluginManifest(
      [
        "name: github",
        "description: GitHub",
        "credentials:",
        "  type: oauth-bearer",
        "  domains:",
        "    - api.github.com",
        "  auth-token-env: GITHUB_TOKEN",
        "oauth:",
        "  client-id-env: GITHUB_CLIENT_ID",
        "  client-secret-env: GITHUB_CLIENT_SECRET",
        "  authorize-endpoint: https://github.com/login/oauth/authorize",
        "  token-endpoint: https://github.com/login/oauth/access_token",
        "  scope: repo",
      ].join("\n"),
      "/plugins/github",
      {
        manifests: {
          github: {
            credentials: {
              domains: ["api.github.com", "uploads.github.com"],
            },
            oauth: {
              scope: "repo read:org workflow",
            },
          },
        },
      },
    );

    expect(manifest.credentials?.domains).toEqual([
      "api.github.com",
      "uploads.github.com",
    ]);
    expect(manifest.oauth?.scope).toBe("repo read:org workflow");
  });

  it("overrides GitHub App system read permissions through manifest config", () => {
    const manifest = parsePluginManifest(
      [
        "name: github",
        "description: GitHub",
        "credentials:",
        "  type: github-app",
        "  domains:",
        "    - api.github.com",
        "  auth-token-env: GITHUB_TOKEN",
        "  app-id-env: GITHUB_APP_ID",
        "  private-key-env: GITHUB_APP_PRIVATE_KEY",
        "  installation-id-env: GITHUB_INSTALLATION_ID",
      ].join("\n"),
      "/plugins/github",
      {
        manifests: {
          github: {
            credentials: {
              systemReadPermissions: ["contents", "pull-requests"],
            },
          },
        },
      },
    );

    expect(
      manifest.credentials?.type === "github-app"
        ? manifest.credentials.systemReadPermissions
        : undefined,
    ).toEqual(["contents", "pull_requests"]);
  });

  it("parses treat-empty-scope-as-unreported from YAML oauth block", () => {
    const manifest = parsePluginManifest(
      [
        "name: github",
        "description: GitHub",
        "credentials:",
        "  type: github-app",
        "  domains:",
        "    - api.github.com",
        "    - github.com",
        "  auth-token-env: GITHUB_TOKEN",
        "  app-id-env: GITHUB_APP_ID",
        "  private-key-env: GITHUB_APP_PRIVATE_KEY",
        "  installation-id-env: GITHUB_INSTALLATION_ID",
        "oauth:",
        "  client-id-env: GITHUB_APP_CLIENT_ID",
        "  client-secret-env: GITHUB_APP_CLIENT_SECRET",
        "  authorize-endpoint: https://github.com/login/oauth/authorize",
        "  token-endpoint: https://github.com/login/oauth/access_token",
        "  treat-empty-scope-as-unreported: true",
      ].join("\n"),
      "/plugins/github",
    );

    expect(manifest.oauth?.treatEmptyScopeAsUnreported).toBe(true);
  });

  it("round-trips treatEmptyScopeAsUnreported through inline manifest parsing", () => {
    const input: PluginManifest = {
      name: "github",
      description: "GitHub",
      capabilities: [],
      configKeys: [],
      credentials: {
        type: "github-app",
        domains: ["api.github.com"],
        authTokenEnv: "GITHUB_TOKEN",
        appIdEnv: "GITHUB_APP_ID",
        privateKeyEnv: "GITHUB_APP_PRIVATE_KEY",
        installationIdEnv: "GITHUB_INSTALLATION_ID",
      },
      oauth: {
        clientIdEnv: "GITHUB_APP_CLIENT_ID",
        clientSecretEnv: "GITHUB_APP_CLIENT_SECRET",
        authorizeEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        treatEmptyScopeAsUnreported: true,
      },
    };

    const parsed = parseInlinePluginManifest(input, "/plugins/github");

    expect(parsed.oauth?.treatEmptyScopeAsUnreported).toBe(true);
  });

  it("allows GitHub App credentials to declare user OAuth", () => {
    const manifest = parsePluginManifest(
      [
        "name: github",
        "description: GitHub",
        "credentials:",
        "  type: github-app",
        "  domains:",
        "    - api.github.com",
        "    - github.com",
        "  auth-token-env: GITHUB_TOKEN",
        "  app-id-env: GITHUB_APP_ID",
        "  private-key-env: GITHUB_APP_PRIVATE_KEY",
        "  installation-id-env: GITHUB_INSTALLATION_ID",
        "oauth:",
        "  client-id-env: GITHUB_APP_CLIENT_ID",
        "  client-secret-env: GITHUB_APP_CLIENT_SECRET",
        "  authorize-endpoint: https://github.com/login/oauth/authorize",
        "  token-endpoint: https://github.com/login/oauth/access_token",
      ].join("\n"),
      "/plugins/github",
    );

    expect(manifest.credentials?.type).toBe("github-app");
    expect(manifest.oauth).toMatchObject({
      clientIdEnv: "GITHUB_APP_CLIENT_ID",
      clientSecretEnv: "GITHUB_APP_CLIENT_SECRET",
    });
  });

  it("rejects invalid GitHub App system read permissions during manifest parsing", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: github",
          "description: GitHub",
          "credentials:",
          "  type: github-app",
          "  domains:",
          "    - api.github.com",
          "  auth-token-env: GITHUB_TOKEN",
          "  app-id-env: GITHUB_APP_ID",
          "  private-key-env: GITHUB_APP_PRIVATE_KEY",
          "  installation-id-env: GITHUB_INSTALLATION_ID",
          "  system-read-permissions:",
          "    - typo-scope",
        ].join("\n"),
        "/plugins/github",
      ),
    ).toThrow(
      'Plugin github credentials.system-read-permissions contains unsupported scope "typo-scope"',
    );
  });

  it("removes optional map entries with null config values", () => {
    const manifest = parsePluginManifest(
      [
        "name: sentry",
        "description: Sentry",
        "env-vars:",
        "  SENTRY_AUTH_HEADER:",
        "domains:",
        "  - sentry.io",
        "api-headers:",
        "  Authorization: ${SENTRY_AUTH_HEADER}",
        "  X-Remove-Me: old",
      ].join("\n"),
      "/plugins/sentry",
      {
        manifests: {
          sentry: {
            apiHeaders: {
              "X-Remove-Me": null,
              "X-Keep-Me": "new",
            },
          },
        },
      },
    );

    expect(manifest.apiHeaders).toEqual({
      Authorization: "${SENTRY_AUTH_HEADER}",
      "X-Keep-Me": "new",
    });
  });

  it("removes nested oauth map entries with null config values", () => {
    const manifest = parsePluginManifest(
      [
        "name: github",
        "description: GitHub",
        "credentials:",
        "  type: oauth-bearer",
        "  domains:",
        "    - api.github.com",
        "  auth-token-env: GITHUB_TOKEN",
        "oauth:",
        "  client-id-env: GITHUB_CLIENT_ID",
        "  client-secret-env: GITHUB_CLIENT_SECRET",
        "  authorize-endpoint: https://github.com/login/oauth/authorize",
        "  token-endpoint: https://github.com/login/oauth/access_token",
        "  authorize-params:",
        "    audience: old",
        "    keep: old",
      ].join("\n"),
      "/plugins/github",
      {
        manifests: {
          github: {
            oauth: {
              authorizeParams: {
                audience: null,
                keep: "new",
              },
            },
          },
        },
      },
    );

    expect(manifest.oauth?.authorizeParams).toEqual({
      keep: "new",
    });
  });

  it("rejects plugin name changes from manifest config", () => {
    expect(() =>
      parsePluginManifest(
        ["name: sentry", "description: Sentry"].join("\n"),
        "/plugins/sentry",
        {
          manifests: {
            sentry: {
              name: "github",
            } as never,
          },
        },
      ),
    ).toThrow("plugins.manifests cannot change plugin names");
  });
});
