import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@/chat/plugins/manifest";

const githubCredentials = [
  "credentials:",
  "  type: github-app",
  "  api-domains:",
  "    - api.github.com",
  "  command-proxies:",
  "    - gh",
  "    - git",
  "  auth-token-env: GITHUB_TOKEN",
  "  app-id-env: GITHUB_APP_ID",
  "  private-key-env: GITHUB_APP_PRIVATE_KEY",
  "  installation-id-env: GITHUB_INSTALLATION_ID",
];

describe("plugin manifest command proxies", () => {
  it("parses command proxy declarations", () => {
    const manifest = parsePluginManifest(
      ["name: github", "description: GitHub access", ...githubCredentials].join(
        "\n",
      ),
      "/tmp/github",
    );

    expect(manifest.commandProxies).toEqual(["gh", "git"]);
  });

  it("rejects invalid command proxy executable names", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: github",
          "description: GitHub access",
          "credentials:",
          "  type: github-app",
          "  api-domains:",
          "    - api.github.com",
          "  command-proxies:",
          "    - gh --repo",
          "  auth-token-env: GITHUB_TOKEN",
          "  app-id-env: GITHUB_APP_ID",
          "  private-key-env: GITHUB_APP_PRIVATE_KEY",
          "  installation-id-env: GITHUB_INSTALLATION_ID",
        ].join("\n"),
        "/tmp/github",
      ),
    ).toThrow("Plugin github command-proxies command must be");
  });

  it("rejects object entries", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: github",
          "description: GitHub access",
          "credentials:",
          "  type: github-app",
          "  api-domains:",
          "    - api.github.com",
          "  command-proxies:",
          "    - command: gh",
          "  auth-token-env: GITHUB_TOKEN",
          "  app-id-env: GITHUB_APP_ID",
          "  private-key-env: GITHUB_APP_PRIVATE_KEY",
          "  installation-id-env: GITHUB_INSTALLATION_ID",
        ].join("\n"),
        "/tmp/github",
      ),
    ).toThrow("Plugin github command-proxies entries must be strings");
  });
});
