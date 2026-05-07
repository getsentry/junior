import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@/chat/plugins/manifest";

describe("plugin manifest API headers", () => {
  it("parses plugin-level API headers with literal and env-backed values", () => {
    const manifest = parsePluginManifest(
      [
        "name: example",
        "description: Example API access",
        "env-vars:",
        "  EXAMPLE_AUTH_HEADER:",
        "api-domains:",
        "  - api.example.com",
        "api-headers:",
        '  Authorization: "${EXAMPLE_AUTH_HEADER}"',
        '  Content-Type: "text/plain"',
      ].join("\n"),
      "/tmp/example",
    );

    expect(manifest.credentials).toBeUndefined();
    expect(manifest.apiDomains).toEqual(["api.example.com"]);
    expect(manifest.apiHeaders).toEqual({
      Authorization: "${EXAMPLE_AUTH_HEADER}",
      "Content-Type": "text/plain",
    });
  });

  it("rejects API headers without API domains", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "api-headers:",
          '  Content-Type: "text/plain"',
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow("Plugin example api-headers requires api-domains");
  });

  it("rejects empty API headers", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "api-domains:",
          "  - api.example.com",
          "api-headers: {}",
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow("Plugin example api-headers must contain at least one header");
  });

  it("rejects undeclared API header env vars", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "api-domains:",
          "  - api.example.com",
          "api-headers:",
          '  Authorization: "${EXAMPLE_AUTH_HEADER}"',
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow(
      "Plugin example api-headers.Authorization references env var EXAMPLE_AUTH_HEADER which is not declared in env-vars",
    );
  });

  it("rejects API header env vars with defaults", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "env-vars:",
          "  EXAMPLE_AUTH_HEADER:",
          '    default: "Basic abc123"',
          "api-domains:",
          "  - api.example.com",
          "api-headers:",
          '  Authorization: "${EXAMPLE_AUTH_HEADER}"',
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow(
      "Plugin example api-headers.Authorization references env var EXAMPLE_AUTH_HEADER, but API header env vars must not declare defaults",
    );
  });
});
