import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginPackageApp,
  expectPluginRegistryLoadFailure,
  resetPluginPackageRegistryState,
} from "../../fixtures/plugin-packages";

afterEach(() => {
  resetPluginPackageRegistryState();
});

describe("plugin package MCP metadata", () => {
  it("infers HTTP MCP configuration from packaged plugins with a URL", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-mcp",
        manifest: [
          "name: demo",
          "description: Demo MCP plugin",
          "mcp:",
          "  url: https://mcp.example.com",
          "  headers:",
          '    X-Workspace: "acme"',
          "  allowed-tools:",
          "    - search",
          "    - fetch",
        ],
      },
    ]);

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
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-mcp-invalid-allowed-tools",
        manifest: [
          "name: demo",
          "description: Demo MCP plugin",
          "mcp:",
          "  transport: http",
          "  url: https://mcp.example.com",
          '  allowed-tools: "search"',
        ],
      },
    ]);

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-mcp-invalid-allowed-tools"],
      "Plugin demo mcp.allowed-tools must be an array of strings when provided",
    );
  });

  it("rejects Authorization in plugin MCP headers", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-mcp-forbidden-header",
        manifest: [
          "name: demo",
          "description: Demo MCP plugin",
          "mcp:",
          "  transport: http",
          "  url: https://mcp.example.com",
          "  headers:",
          '    Authorization: "Bearer nope"',
        ],
      },
    ]);

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-mcp-forbidden-header"],
      "Plugin demo mcp.headers.Authorization is not allowed",
    );
  });

  it("rejects non-http MCP transports", async () => {
    await createPluginPackageApp([
      {
        packageName: "junior-plugin-mcp-invalid-transport",
        manifest: [
          "name: demo",
          "description: Demo MCP plugin",
          "mcp:",
          "  transport: stdio",
          "  url: https://mcp.example.com",
        ],
      },
    ]);

    await expectPluginRegistryLoadFailure(
      ["@acme/junior-plugin-mcp-invalid-transport"],
      'Plugin demo mcp.transport must be "http"',
    );
  });
});
