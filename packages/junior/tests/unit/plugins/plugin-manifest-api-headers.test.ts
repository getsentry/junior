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
        "domains:",
        "  - api.example.com",
        "api-headers:",
        '  Authorization: "${EXAMPLE_AUTH_HEADER}"',
        '  Content-Type: "text/plain"',
      ].join("\n"),
      "/tmp/example",
    );

    expect(manifest.credentials).toBeUndefined();
    expect(manifest.domains).toEqual(["api.example.com"]);
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
        "domains:",
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

  it("parses command env with host env references", () => {
    const manifest = parsePluginManifest(
      [
        "name: example",
        "description: Example API access",
        "env-vars:",
        "  EXAMPLE_BOT_EMAIL:",
        "credentials:",
        "  type: oauth-bearer",
        "  domains:",
        "    - api.example.com",
        "  auth-token-env: EXAMPLE_TOKEN",
        "command-env:",
        '  GIT_AUTHOR_EMAIL: "${EXAMPLE_BOT_EMAIL}"',
      ].join("\n"),
      "/tmp/example",
    );

    expect(manifest.envVars?.EXAMPLE_BOT_EMAIL).toEqual({});
    expect(manifest.commandEnv).toEqual({
      GIT_AUTHOR_EMAIL: "${EXAMPLE_BOT_EMAIL}",
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

  it("parses the packaged Vercel manifest", () => {
    const manifestPath = path.resolve(
      process.cwd(),
      "../junior-vercel/plugin.yaml",
    );
    const manifest = parsePluginManifest(
      readFileSync(manifestPath, "utf8"),
      path.dirname(manifestPath),
    );

    expect(manifest.name).toBe("vercel");
    expect(manifest.domains).toEqual(["api.vercel.com"]);
    expect(manifest.apiHeaders).toEqual({
      Authorization: "Bearer ${JUNIOR_VERCEL_TOKEN}",
    });
    expect(manifest.commandEnv).toEqual({
      VERCEL_TOKEN: "host_managed_credential",
    });
    expect(manifest.runtimeDependencies).toEqual([
      {
        type: "npm",
        package: "vercel",
        version: "latest",
      },
    ]);
  });

  it("parses the packaged GitHub command env host bindings", () => {
    const manifestPath = path.resolve(
      process.cwd(),
      "../junior-github/plugin.yaml",
    );
    const manifest = parsePluginManifest(
      readFileSync(manifestPath, "utf8"),
      path.dirname(manifestPath),
    );

    expect(manifest.envVars).toMatchObject({
      GITHUB_APP_BOT_NAME: {},
      GITHUB_APP_BOT_EMAIL: {},
    });
    expect(manifest.commandEnv).toMatchObject({
      GIT_AUTHOR_NAME: "${GITHUB_APP_BOT_NAME}",
      GIT_AUTHOR_EMAIL: "${GITHUB_APP_BOT_EMAIL}",
      GIT_COMMITTER_NAME: "${GITHUB_APP_BOT_NAME}",
      GIT_COMMITTER_EMAIL: "${GITHUB_APP_BOT_EMAIL}",
    });
  });

  it("leaves defaultless command env references for runtime host binding", () => {
    const manifest = parsePluginManifest(
      [
        "name: example",
        "description: Example API access",
        "env-vars:",
        "  EXAMPLE_BOT_EMAIL:",
        "credentials:",
        "  type: oauth-bearer",
        "  domains:",
        "    - api.example.com",
        "  auth-token-env: EXAMPLE_TOKEN",
        "command-env:",
        '  GIT_AUTHOR_EMAIL: "${EXAMPLE_BOT_EMAIL}"',
      ].join("\n"),
      "/tmp/example",
    );

    expect(manifest.commandEnv).toEqual({
      GIT_AUTHOR_EMAIL: "${EXAMPLE_BOT_EMAIL}",
    });
  });

  it("rejects unknown env var declaration fields", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "env-vars:",
          "  EXAMPLE_BOT_EMAIL:",
          "    expose-to-command-env: true",
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - api.example.com",
          "  auth-token-env: EXAMPLE_TOKEN",
          "command-env:",
          '  GIT_AUTHOR_EMAIL: "${EXAMPLE_BOT_EMAIL}"',
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow("Plugin example env-vars.EXAMPLE_BOT_EMAIL");
  });

  it("rejects command env references that reuse API header env vars", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "env-vars:",
          "  EXAMPLE_AUTH_HEADER:",
          "domains:",
          "  - api.example.com",
          "api-headers:",
          '  Authorization: "${EXAMPLE_AUTH_HEADER}"',
          "command-env:",
          '  EXAMPLE_TOKEN: "${EXAMPLE_AUTH_HEADER}"',
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow(
      "Plugin example command-env.EXAMPLE_TOKEN references env var EXAMPLE_AUTH_HEADER, but credential/API header env vars must stay host-only",
    );
  });

  it("rejects command env references that reuse credential env vars", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "env-vars:",
          "  EXAMPLE_TOKEN:",
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - api.example.com",
          "  auth-token-env: EXAMPLE_TOKEN",
          "command-env:",
          '  EXAMPLE_TOKEN: "${EXAMPLE_TOKEN}"',
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow(
      "Plugin example command-env.EXAMPLE_TOKEN references env var EXAMPLE_TOKEN, but credential/API header env vars must stay host-only",
    );
  });

  it("rejects command env references that reuse OAuth env vars", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "env-vars:",
          "  EXAMPLE_CLIENT_SECRET:",
          "credentials:",
          "  type: oauth-bearer",
          "  domains:",
          "    - api.example.com",
          "  auth-token-env: EXAMPLE_TOKEN",
          "oauth:",
          "  client-id-env: EXAMPLE_CLIENT_ID",
          "  client-secret-env: EXAMPLE_CLIENT_SECRET",
          "  authorize-endpoint: https://example.com/oauth/authorize",
          "  token-endpoint: https://example.com/oauth/token",
          "command-env:",
          '  EXAMPLE_SECRET: "${EXAMPLE_CLIENT_SECRET}"',
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow(
      "Plugin example command-env.EXAMPLE_SECRET references env var EXAMPLE_CLIENT_SECRET, but credential/API header env vars must stay host-only",
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

  it("rejects API headers without domains", () => {
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
    ).toThrow("Plugin example api-headers requires domains");
  });

  it("accepts credential-backed top-level domains without API headers", () => {
    const manifest = parsePluginManifest(
      [
        "name: example",
        "description: Example API access",
        "domains:",
        "  - uploads.example.com",
        "credentials:",
        "  type: oauth-bearer",
        "  domains:",
        "    - api.example.com",
        "  auth-token-env: EXAMPLE_TOKEN",
      ].join("\n"),
      "/tmp/example",
    );

    expect(manifest.domains).toEqual(["uploads.example.com"]);
    expect(manifest.apiHeaders).toBeUndefined();
    expect(manifest.credentials).toMatchObject({
      type: "oauth-bearer",
      domains: ["api.example.com"],
      authTokenEnv: "EXAMPLE_TOKEN",
    });
  });

  it("reports domains when credentials and headers are missing", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "domains:",
          "  - api.example.com",
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow("Plugin example domains requires credentials or api-headers");
  });

  it("rejects empty API headers", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "domains:",
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
          "domains:",
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
          "domains:",
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
