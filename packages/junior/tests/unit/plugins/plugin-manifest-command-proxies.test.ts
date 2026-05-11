import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@/chat/plugins/manifest";

const githubCredentials = [
  "credentials:",
  "  type: github-app",
  "  api-domains:",
  "    - api.github.com",
  "  auth-token-env: GITHUB_TOKEN",
  "  app-id-env: GITHUB_APP_ID",
  "  private-key-env: GITHUB_APP_PRIVATE_KEY",
  "  installation-id-env: GITHUB_INSTALLATION_ID",
];

describe("plugin manifest command proxies", () => {
  it("parses command proxy declarations", () => {
    const manifest = parsePluginManifest(
      [
        "name: github",
        "description: GitHub access",
        ...githubCredentials,
        "command-proxies:",
        "  - gh",
        "  - git",
      ].join("\n"),
      "/tmp/github",
    );

    expect(manifest.commandProxies).toEqual([
      { command: "gh", provider: "github" },
      { command: "git", provider: "github" },
    ]);
  });

  it("rejects invalid command proxy executable names", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: github",
          "description: GitHub access",
          ...githubCredentials,
          "command-proxies:",
          "  - gh --repo",
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
          ...githubCredentials,
          "command-proxies:",
          "  - command: gh",
        ].join("\n"),
        "/tmp/github",
      ),
    ).toThrow("Plugin github command-proxies entries must be strings");
  });

  it("rejects command proxies without a credential broker", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: github",
          "description: GitHub access",
          "command-proxies:",
          "  - gh",
        ].join("\n"),
        "/tmp/github",
      ),
    ).toThrow("Plugin github command-proxies requires credentials");
  });
});
