import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDefinition } from "@/chat/plugins/types";

const { logWarnMock } = vi.hoisted(() => ({
  logWarnMock: vi.fn(),
}));

vi.mock("@/chat/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/logging")>();
  return {
    ...actual,
    logWarn: logWarnMock,
  };
});

import {
  McpAuthorizationRequiredError,
  type PluginMcpClientOptions,
} from "@/chat/mcp/client";
import {
  McpToolManager,
  type McpToolManagerOptions,
} from "@/chat/mcp/tool-manager";

const callToolMock = vi.fn();
const clientOptions: PluginMcpClientOptions[] = [];
const clientSetupError: { value: unknown } = { value: undefined };
const closeMock = vi.fn();
const listToolsMock = vi.fn();
const onAuthorizationRequiredMock = vi.fn();

function buildPlugin(
  name = "demo",
  options: { allowedTools?: string[] } = {},
): PluginDefinition {
  return {
    dir: `/tmp/plugins/${name}`,
    skillsDir: `/tmp/plugins/${name}/skills`,
    manifest: {
      name,
      displayName: "Demo",
      description: "Demo MCP plugin",
      capabilities: [],
      configKeys: [],
      mcp: {
        transport: "http",
        url: "https://mcp.example.com",
        ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      },
    },
  };
}

function createTestClientFactory(): NonNullable<
  McpToolManagerOptions["clientFactory"]
> {
  return (plugin, options) => {
    if (clientSetupError.value) {
      throw clientSetupError.value;
    }
    clientOptions.push(options);
    return {
      async listTools() {
        return await listToolsMock(plugin);
      },
      async callTool(name, args) {
        return await callToolMock(plugin, name, args);
      },
      async close() {
        await closeMock(plugin);
      },
    };
  };
}

function createMcpToolManager(
  plugins: PluginDefinition[],
  options: McpToolManagerOptions = {},
) {
  return new McpToolManager(plugins, {
    ...options,
    clientFactory: options.clientFactory ?? createTestClientFactory(),
  });
}

function discoveredTool(name: string, title: string, description = title) {
  return {
    name,
    title,
    description,
    inputSchema: { type: "object", properties: {} },
  };
}

const notionTools = [
  discoveredTool("notion-search", "Search", "Search Notion"),
  discoveredTool("notion-fetch", "Fetch", "Fetch Notion content"),
  discoveredTool("notion-create-pages", "Create", "Create Notion pages"),
];

describe("McpToolManager", () => {
  beforeEach(() => {
    listToolsMock.mockReset();
    callToolMock.mockReset();
    closeMock.mockReset();
    onAuthorizationRequiredMock.mockReset();
    clientOptions.length = 0;
    clientSetupError.value = undefined;

    listToolsMock.mockResolvedValue([
      {
        name: "ping",
        title: "Ping",
        description: "Ping the remote MCP server",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
    ]);
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: "pong" }],
      isError: false,
    });
    closeMock.mockResolvedValue(undefined);
    onAuthorizationRequiredMock.mockResolvedValue(undefined);
  });

  it("activates plugin-scoped MCP tools once with collision-safe names", async () => {
    const plugin = buildPlugin();
    const manager = createMcpToolManager([plugin]);

    expect(
      await manager.activateForSkill({
        name: "demo-skill",
        pluginProvider: undefined,
      }),
    ).toBe(false);
    expect(
      await manager.activateForSkill({
        name: "demo-skill",
        pluginProvider: "demo",
      }),
    ).toBe(true);
    expect(await manager.activateProvider("demo")).toBe(false);
    expect(manager.getActiveProviders()).toEqual(["demo"]);

    const tools = manager.getActiveToolCatalog();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("mcp__demo__ping");
    expect(tools[0]?.rawName).toBe("ping");
    expect(tools[0]?.description).toBe("[demo] Ping the remote MCP server");

    const resolvedTools = manager.getResolvedActiveTools();
    expect(resolvedTools).toHaveLength(1);
    const result = await resolvedTools[0]!.execute({ query: "hello" });

    expect(callToolMock).toHaveBeenCalledWith(plugin, "ping", {
      query: "hello",
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "pong" }],
      details: {
        provider: "demo",
        tool: "ping",
        rawResult: {
          content: [{ type: "text", text: "pong" }],
          isError: false,
        },
      },
    });

    await manager.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(clientOptions).not.toContainEqual(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
    expect(manager.getActiveToolCatalog()).toEqual([]);
  });

  it("logs expected MCP tool errors with semantic context", async () => {
    const plugin = buildPlugin();
    const manager = createMcpToolManager([plugin]);
    await manager.activateProvider("demo");
    callToolMock.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Input validation error: Invalid input: expected object, received undefined",
        },
      ],
      isError: true,
    });

    const resolvedTools = manager.getResolvedActiveTools();
    await expect(resolvedTools[0]!.execute({})).rejects.toThrow(
      "expected object, received undefined",
    );
  });

  it("surfaces MCP authorization challenges through the callback hook", async () => {
    const plugin = buildPlugin();
    const manager = createMcpToolManager([plugin], {
      onAuthorizationRequired: onAuthorizationRequiredMock,
    });
    await manager.activateProvider("demo");
    callToolMock.mockRejectedValueOnce(
      new McpAuthorizationRequiredError("demo", "Auth required"),
    );

    const resolvedTools = manager.getResolvedActiveTools();
    await expect(resolvedTools[0]!.execute({})).rejects.toBeInstanceOf(
      McpAuthorizationRequiredError,
    );
    expect(onAuthorizationRequiredMock).toHaveBeenCalledTimes(1);
    expect(onAuthorizationRequiredMock).toHaveBeenCalledWith(
      "demo",
      expect.objectContaining({
        provider: "demo",
        message: "Auth required",
      }),
    );
  });

  it("parks handled MCP authorization challenges without surfacing a tool error", async () => {
    const plugin = buildPlugin();
    onAuthorizationRequiredMock.mockResolvedValueOnce(true);
    const manager = createMcpToolManager([plugin], {
      onAuthorizationRequired: onAuthorizationRequiredMock,
    });
    await manager.activateProvider("demo");
    callToolMock.mockRejectedValueOnce(
      new McpAuthorizationRequiredError("demo", "Auth required"),
    );

    const resolvedTools = manager.getResolvedActiveTools();
    await expect(resolvedTools[0]!.execute({})).resolves.toEqual({
      content: [{ type: "text", text: "Authorization pending." }],
      details: {
        provider: "demo",
        tool: "ping",
        rawResult: {
          toolResult: {
            authorizationPending: true,
          },
        },
      },
    });
    expect(onAuthorizationRequiredMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces MCP authorization challenges during tool discovery", async () => {
    const plugin = buildPlugin();
    const manager = createMcpToolManager([plugin], {
      onAuthorizationRequired: onAuthorizationRequiredMock,
    });
    listToolsMock.mockRejectedValueOnce(
      new McpAuthorizationRequiredError("demo", "Discovery auth required"),
    );

    await expect(manager.activateProvider("demo")).rejects.toBeInstanceOf(
      McpAuthorizationRequiredError,
    );
    expect(onAuthorizationRequiredMock).toHaveBeenCalledTimes(1);
    expect(onAuthorizationRequiredMock).toHaveBeenCalledWith(
      "demo",
      expect.objectContaining({
        provider: "demo",
        message: "Discovery auth required",
      }),
    );
  });

  it("does not retry activation for a provider already parked for auth", async () => {
    const plugin = buildPlugin();
    onAuthorizationRequiredMock.mockResolvedValueOnce(true);
    const manager = createMcpToolManager([plugin], {
      onAuthorizationRequired: onAuthorizationRequiredMock,
    });
    listToolsMock.mockRejectedValueOnce(
      new McpAuthorizationRequiredError("demo", "Discovery auth required"),
    );

    await expect(manager.activateProvider("demo")).resolves.toBe(false);
    await expect(manager.activateProvider("demo")).resolves.toBe(false);

    expect(onAuthorizationRequiredMock).toHaveBeenCalledTimes(1);
    expect(listToolsMock).toHaveBeenCalledTimes(1);
    expect(clientOptions).toHaveLength(1);
    expect(manager.getActiveProviders()).toEqual([]);
  });

  it("parks handled MCP authorization challenges during initial client setup", async () => {
    const plugin = buildPlugin();
    const authError = new McpAuthorizationRequiredError(
      "demo",
      "Connect auth required",
    );
    clientSetupError.value = authError;
    onAuthorizationRequiredMock.mockResolvedValueOnce(true);
    const manager = createMcpToolManager([plugin], {
      onAuthorizationRequired: onAuthorizationRequiredMock,
    });

    await expect(manager.activateProvider("demo")).resolves.toBe(false);
    expect(onAuthorizationRequiredMock).toHaveBeenCalledTimes(1);
    expect(onAuthorizationRequiredMock).toHaveBeenCalledWith("demo", authError);
    expect(manager.getActiveProviders()).toEqual([]);
  });

  it("closes every active client before surfacing the first close error", async () => {
    const alphaPlugin = buildPlugin("alpha");
    const betaPlugin = buildPlugin("beta");
    const manager = createMcpToolManager([alphaPlugin, betaPlugin]);

    await manager.activateProvider("alpha");
    await manager.activateProvider("beta");

    closeMock.mockImplementation(async (plugin: PluginDefinition) => {
      if (plugin.manifest.name === "alpha") {
        throw new Error("alpha close failed");
      }
    });

    await expect(manager.close()).rejects.toThrow("alpha close failed");
    expect(closeMock).toHaveBeenCalledTimes(2);
    expect(closeMock).toHaveBeenNthCalledWith(1, alphaPlugin);
    expect(closeMock).toHaveBeenNthCalledWith(2, betaPlugin);
    expect(manager.getActiveProviders()).toEqual([]);
    expect(manager.getActiveToolCatalog()).toEqual([]);
  });

  it("filters MCP tools to the provider allowlist", async () => {
    const plugin = buildPlugin("notion", {
      allowedTools: ["notion-search", "notion-fetch"],
    });
    listToolsMock.mockResolvedValue(notionTools);

    const manager = createMcpToolManager([plugin]);
    await manager.activateProvider("notion");

    expect(manager.getActiveToolCatalog().map((tool) => tool.name)).toEqual([
      "mcp__notion__notion-search",
      "mcp__notion__notion-fetch",
    ]);
  });

  it("exposes the provider tool catalog once a provider is active, without requiring a skill", async () => {
    const plugin = buildPlugin("notion");
    listToolsMock.mockResolvedValue(notionTools);

    const manager = createMcpToolManager([plugin]);
    await manager.activateProvider("notion");

    expect(manager.getActiveToolCatalog().map((tool) => tool.name)).toEqual([
      "mcp__notion__notion-search",
      "mcp__notion__notion-fetch",
      "mcp__notion__notion-create-pages",
    ]);
    const createPagesTool = manager
      .getResolvedActiveTools()
      .find((t) => t.name === "mcp__notion__notion-create-pages");
    await expect(createPagesTool!.execute({})).resolves.toMatchObject({
      details: {
        provider: "notion",
        tool: "notion-create-pages",
      },
    });
  });

  it("getAvailableProviderCatalog returns all configured providers without connecting", async () => {
    const notionPlugin = buildPlugin("notion");
    const linearPlugin = buildPlugin("linear");
    const manager = createMcpToolManager([notionPlugin, linearPlugin]);

    const catalog = manager.getAvailableProviderCatalog();
    expect(catalog).toHaveLength(2);
    expect(catalog.map((p) => p.provider)).toEqual(["linear", "notion"]);
    expect(catalog.every((p) => !p.active)).toBe(true);
    expect(listToolsMock).not.toHaveBeenCalled();

    await manager.activateProvider("notion");
    const after = manager.getAvailableProviderCatalog();
    expect(after.find((p) => p.provider === "notion")?.active).toBe(true);
    expect(after.find((p) => p.provider === "linear")?.active).toBe(false);
  });

  it("fails activation when an allowlisted MCP tool is missing", async () => {
    const plugin = buildPlugin("notion", {
      allowedTools: ["notion-search", "notion-fetch"],
    });
    listToolsMock.mockResolvedValue([
      discoveredTool("notion-search", "Search", "Search Notion"),
    ]);

    const manager = createMcpToolManager([plugin]);

    await expect(manager.activateProvider("notion")).rejects.toThrow(
      "Plugin notion MCP discovery missing allowlisted tools: notion-fetch",
    );
  });
});
