import { describe, expect, it } from "vitest";
import {
  parseInlinePluginManifest,
  parsePluginManifest,
} from "@/chat/plugins/manifest";

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

  it("overrides empty OAuth scope reporting through manifest config", () => {
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
        "  client-id-env: GITHUB_APP_CLIENT_ID",
        "  client-secret-env: GITHUB_APP_CLIENT_SECRET",
        "  authorize-endpoint: https://github.com/login/oauth/authorize",
        "  token-endpoint: https://github.com/login/oauth/access_token",
      ].join("\n"),
      "/plugins/github",
      {
        manifests: {
          github: {
            oauth: {
              treatEmptyScopeAsUnreported: true,
            },
          },
        },
      },
    );

    expect(manifest.oauth?.treatEmptyScopeAsUnreported).toBe(true);
  });

  it("parses treat-empty-scope-as-unreported from YAML oauth block", () => {
    const manifest = parsePluginManifest(
      [
        "name: github",
        "description: GitHub",
        "credentials:",
        "  type: oauth-bearer",
        "  domains:",
        "    - api.github.com",
        "    - github.com",
        "  auth-token-env: GITHUB_TOKEN",
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

  it("rejects plugin-managed credentials in plugin.yaml", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: github",
          "description: GitHub",
          "credentials:",
          "  type: plugin-managed",
          "  domains:",
          "    - api.github.com",
          "    - github.com",
        ].join("\n"),
        "/plugins/github",
      ),
    ).toThrow(
      'Plugin github has unsupported credentials.type: "plugin-managed"',
    );
  });

  it("allows code-based egress domains to declare user OAuth", () => {
    const manifest = parseInlinePluginManifest(
      {
        name: "github",
        description: "GitHub",
        capabilities: [],
        configKeys: [],
        domains: ["api.github.com", "github.com"],
        oauth: {
          clientIdEnv: "GITHUB_APP_CLIENT_ID",
          clientSecretEnv: "GITHUB_APP_CLIENT_SECRET",
          authorizeEndpoint: "https://github.com/login/oauth/authorize",
          tokenEndpoint: "https://github.com/login/oauth/access_token",
        },
      },
      "/plugins/github",
    );

    expect(manifest.credentials).toBeUndefined();
    expect(manifest.domains).toEqual(["api.github.com", "github.com"]);
    expect(manifest.oauth).toMatchObject({
      clientIdEnv: "GITHUB_APP_CLIENT_ID",
      clientSecretEnv: "GITHUB_APP_CLIENT_SECRET",
    });
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
