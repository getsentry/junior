import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginPackageApp,
  expectPluginRegistryLoadFailure,
  resetPluginPackageRegistryState,
} from "../../fixtures/plugin-packages";

afterEach(() => {
  resetPluginPackageRegistryState();
});

describe("plugin package env vars", () => {
  it("resolves ${VAR} to env-vars default when process.env is unset", async () => {
    const previous = process.env.JUNIOR_TEST_MCP_HOST;
    delete process.env.JUNIOR_TEST_MCP_HOST;
    try {
      await createPluginPackageApp([
        {
          packageName: "junior-plugin-mcp-template",
          manifest: [
            "name: demo",
            "description: Demo MCP plugin",
            "env-vars:",
            "  JUNIOR_TEST_MCP_HOST:",
            "    default: example.com",
            "mcp:",
            "  url: https://mcp.${JUNIOR_TEST_MCP_HOST}/api/unstable/mcp-server/mcp?toolsets=core",
          ],
        },
      ]);

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
      await createPluginPackageApp([
        {
          packageName: "junior-plugin-mcp-template",
          manifest: [
            "name: demo",
            "description: Demo MCP plugin",
            "env-vars:",
            "  JUNIOR_TEST_MCP_HOST:",
            "    default: example.com",
            "mcp:",
            "  url: https://mcp.${JUNIOR_TEST_MCP_HOST}/api/unstable/mcp-server/mcp?toolsets=core",
          ],
        },
      ]);

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
      await createPluginPackageApp([
        {
          packageName: "junior-plugin-mcp-template",
          manifest: [
            "name: demo",
            "description: Demo MCP plugin",
            "env-vars:",
            "  JUNIOR_TEST_MCP_HOST:",
            "mcp:",
            "  url: https://mcp.${JUNIOR_TEST_MCP_HOST}/api/unstable/mcp-server/mcp",
          ],
        },
      ]);

      await expectPluginRegistryLoadFailure(
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

  it("fails to load when mcp.url references an undeclared env var", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-mcp-template",
        manifest: [
          "name: demo",
          "description: Demo MCP plugin",
          "mcp:",
          "  url: https://mcp.${JUNIOR_TEST_UNDECLARED_HOST}/api/unstable/mcp-server/mcp",
        ],
      },
    ]);

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-mcp-template"],
      "Plugin demo mcp.url references env var JUNIOR_TEST_UNDECLARED_HOST which is not declared in env-vars",
    );
  });

  it("rejects env-vars keys that do not match [A-Z_][A-Z0-9_]*", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-mcp-bad-env",
        manifest: [
          "name: demo",
          "description: Demo MCP plugin",
          "env-vars:",
          "  lowercase-name:",
          "    default: x",
          "mcp:",
          "  url: https://mcp.example.com/api",
        ],
      },
    ]);

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-mcp-bad-env"],
      'Plugin demo env-vars key "lowercase-name" must match [A-Z_][A-Z0-9_]*',
    );
  });
});
