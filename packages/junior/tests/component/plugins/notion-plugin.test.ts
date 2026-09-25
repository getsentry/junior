import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { listToolsMock } = vi.hoisted(() => ({
  listToolsMock: vi.fn(),
}));

vi.mock("@/chat/mcp/client", () => ({
  McpAuthorizationRequiredError: class extends Error {},
  PluginMcpClient: class {
    async listTools() {
      return await listToolsMock();
    }

    async close() {}
  },
}));

import { McpToolManager } from "@/chat/mcp/tool-manager";

const originalCwd = process.cwd();
const allowedTools = [
  "notion-search",
  "notion-fetch",
  "notion-create-pages",
  "notion-update-page",
  "notion-move-pages",
];

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  vi.doUnmock("@/chat/discovery");
  listToolsMock.mockReset();
});

describe("Notion plugin package", () => {
  it("discovers the shipped manifest and exposes only allowlisted MCP tools", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-notion-package-"),
    );
    const packageRoot = path.join(
      tempRoot,
      "node_modules",
      "@sentry",
      "junior-notion",
    );
    await fs.mkdir(path.dirname(packageRoot), { recursive: true });
    await fs.cp(
      path.resolve(import.meta.dirname, "../../../../junior-notion"),
      packageRoot,
      { recursive: true },
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "notion-test-app",
        private: true,
        dependencies: { "@sentry/junior-notion": "0.154.0" },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    const { pluginCatalogRuntime } =
      await import("@/chat/plugins/catalog-runtime");
    pluginCatalogRuntime.setConfig({
      packages: ["@sentry/junior-notion"],
    });
    const providers = pluginCatalogRuntime.getProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0]?.manifest.mcp).toMatchObject({
      url: "https://mcp.notion.com/mcp",
    });
    expect(providers[0]?.manifest.mcp?.allowedTools).toEqual(allowedTools);

    listToolsMock.mockResolvedValue([
      ...allowedTools.map((name) => ({
        name,
        description: `Notion ${name}`,
        inputSchema: { type: "object", properties: {} },
      })),
      {
        name: "notion-create-database",
        description: "Create a Notion database",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const manager = new McpToolManager(providers);
    await manager.activateProvider("notion");

    expect(manager.getActiveToolCatalog().map((tool) => tool.rawName)).toEqual(
      allowedTools,
    );
  });
});
