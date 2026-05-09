import { readFileSync } from "node:fs";
import path from "node:path";
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

  it("parses command env with literals and default-backed env references", () => {
    const manifest = parsePluginManifest(
      [
        "name: example",
        "description: Example API access",
        "env-vars:",
        "  EXAMPLE_AUTH_HEADER:",
        "  EXAMPLE_SITE:",
        "    default: example.com",
        "api-domains:",
        "  - api.example.com",
        "api-headers:",
        '  Authorization: "${EXAMPLE_AUTH_HEADER}"',
        "command-env:",
        "  EXAMPLE_API_KEY: host_managed_credential",
        '  EXAMPLE_SITE: "${EXAMPLE_SITE}"',
      ].join("\n"),
      "/tmp/example",
    );

    expect(manifest.commandEnv).toEqual({
      EXAMPLE_API_KEY: "host_managed_credential",
      EXAMPLE_SITE: "example.com",
    });
  });

  it("parses the packaged Datadog manifest", () => {
    const manifestPath = path.resolve(
      process.cwd(),
      "../junior-datadog/plugin.yaml",
    );
    const manifest = parsePluginManifest(
      readFileSync(manifestPath, "utf8"),
      path.dirname(manifestPath),
    );

    expect(manifest.name).toBe("datadog");
    expect(manifest.apiHeaders).toEqual({
      "DD-API-KEY": "${DATADOG_API_KEY}",
      "DD-APPLICATION-KEY": "${DATADOG_APP_KEY}",
    });
    expect(manifest.commandEnv).toEqual({
      DD_API_KEY: "host_managed_credential",
      DD_APP_KEY: "host_managed_credential",
      DD_SITE: "datadoghq.com",
      DD_READ_ONLY: "1",
      FORCE_AGENT_MODE: "1",
    });
    expect(manifest.runtimePostinstall).toHaveLength(1);
  });

  it("rejects command env references without defaults", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "env-vars:",
          "  EXAMPLE_SECRET:",
          "command-env:",
          '  EXAMPLE_TOKEN: "${EXAMPLE_SECRET}"',
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow(
      "Plugin example command-env.EXAMPLE_TOKEN references env var EXAMPLE_SECRET, but command-env env vars must declare defaults",
    );
  });

  it("rejects command env without credentials or API headers", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example CLI access",
          "command-env:",
          "  EXAMPLE_TOKEN: host_managed_credential",
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow("Plugin example command-env requires credentials or api-headers");
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
