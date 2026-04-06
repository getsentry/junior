import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDefinition } from "@/chat/plugins/types";

const {
  callToolMock,
  clientOptions,
  clientSetupError,
  closeMock,
  listToolsMock,
  onAuthorizationRequiredMock,
} = vi.hoisted(() => ({
  callToolMock: vi.fn(),
  clientOptions: [] as unknown[],
  clientSetupError: { value: undefined as unknown },
  closeMock: vi.fn(),
  listToolsMock: vi.fn(),
  onAuthorizationRequiredMock: vi.fn(),
}));

vi.mock("@/chat/mcp/client", () => {
  class MockMcpAuthorizationRequiredError extends Error {
    readonly provider: string;

    constructor(provider: string, message: string) {
      super(message);
      this.name = "McpAuthorizationRequiredError";
      this.provider = provider;
    }
  }

  class MockPluginMcpClient {
    constructor(
      private readonly plugin: PluginDefinition,
      options?: unknown,
    ) {
      if (clientSetupError.value) {
        throw clientSetupError.value;
      }
      clientOptions.push(options);
    }

    async listTools() {
      return await listToolsMock(this.plugin);
    }

    async callTool(name: string, args: Record<string, unknown>) {
      return await callToolMock(this.plugin, name, args);
    }

    async close() {
      await closeMock(this.plugin);
    }
  }

  return {
    McpAuthorizationRequiredError: MockMcpAuthorizationRequiredError,
    PluginMcpClient: MockPluginMcpClient,
  };
});

import { McpAuthorizationRequiredError } from "@/chat/mcp/client";
import { McpToolManager } from "@/chat/mcp/tool-manager";

function buildPlugin(
  name = "demo",
  options: { allowedTools?: string[] } = {},
): PluginDefinition {
  return {
    dir: `/tmp/plugins/${name}`,
    skillsDir: `/tmp/plugins/${name}/skills`,
    manifest: {
      name,
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

  it("activates plugin-scoped MCP tools once and prefixes their names", async () => {
    const plugin = buildPlugin();
    const manager = new McpToolManager([plugin]);
    const activeSkills = [{ name: "demo-skill", pluginProvider: "demo" }];

    expect(
      await manager.activateForSkill({
        name: "demo-skill",
        pluginProvider: undefined,
      }),
    ).toBe(false);
    expect(await manager.activateForSkill(activeSkills[0]!)).toBe(true);
    expect(await manager.activateProvider("demo")).toBe(false);
    expect(manager.getActiveProviders()).toEqual(["demo"]);

    const tools = manager.getActiveToolCatalog(activeSkills);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("mcp__demo__ping");
    expect(tools[0]?.description).toBe("[demo] Ping the remote MCP server");

    const resolvedTools = manager.getResolvedActiveTools(activeSkills);
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
    expect(manager.getActiveToolCatalog(activeSkills)).toEqual([]);
  });

  it("surfaces MCP authorization challenges through the callback hook", async () => {
    const plugin = buildPlugin();
    const manager = new McpToolManager([plugin], {
      onAuthorizationRequired: onAuthorizationRequiredMock,
    });
    const activeSkills = [{ name: "demo-skill", pluginProvider: "demo" }];
    await manager.activateProvider("demo");
    callToolMock.mockRejectedValueOnce(
      new McpAuthorizationRequiredError("demo", "Auth required"),
    );

    const resolvedTools = manager.getResolvedActiveTools(activeSkills);
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
    const manager = new McpToolManager([plugin], {
      onAuthorizationRequired: onAuthorizationRequiredMock,
    });
    const activeSkills = [{ name: "demo-skill", pluginProvider: "demo" }];
    await manager.activateProvider("demo");
    callToolMock.mockRejectedValueOnce(
      new McpAuthorizationRequiredError("demo", "Auth required"),
    );

    const resolvedTools = manager.getResolvedActiveTools(activeSkills);
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
    const manager = new McpToolManager([plugin], {
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

  it("parks handled MCP authorization challenges during discovery", async () => {
    const plugin = buildPlugin();
    onAuthorizationRequiredMock.mockResolvedValueOnce(true);
    const manager = new McpToolManager([plugin], {
      onAuthorizationRequired: onAuthorizationRequiredMock,
    });
    listToolsMock.mockRejectedValueOnce(
      new McpAuthorizationRequiredError("demo", "Discovery auth required"),
    );

    await expect(manager.activateProvider("demo")).resolves.toBe(false);
    expect(onAuthorizationRequiredMock).toHaveBeenCalledTimes(1);
    expect(manager.getActiveProviders()).toEqual([]);
  });

  it("does not retry activation for a provider already parked for auth", async () => {
    const plugin = buildPlugin();
    onAuthorizationRequiredMock.mockResolvedValueOnce(true);
    const manager = new McpToolManager([plugin], {
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
  });

  it("parks handled MCP authorization challenges during initial client setup", async () => {
    const plugin = buildPlugin();
    const authError = new McpAuthorizationRequiredError(
      "demo",
      "Connect auth required",
    );
    clientSetupError.value = authError;
    onAuthorizationRequiredMock.mockResolvedValueOnce(true);
    const manager = new McpToolManager([plugin], {
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
    const manager = new McpToolManager([alphaPlugin, betaPlugin]);

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
    expect(
      manager.getActiveToolCatalog([
        { pluginProvider: "alpha" },
        { pluginProvider: "beta" },
      ]),
    ).toEqual([]);
  });

  it("filters MCP tools to the provider allowlist", async () => {
    const plugin = buildPlugin("notion", {
      allowedTools: ["notion-search", "notion-fetch"],
    });
    listToolsMock.mockResolvedValue([
      {
        name: "notion-search",
        title: "Search",
        description: "Search Notion",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "notion-fetch",
        title: "Fetch",
        description: "Fetch Notion content",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "notion-create-pages",
        title: "Create",
        description: "Create Notion pages",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const manager = new McpToolManager([plugin]);
    await manager.activateProvider("notion");

    expect(
      manager
        .getActiveToolCatalog([{ pluginProvider: "notion" }])
        .map((tool) => tool.name),
    ).toEqual(["mcp__notion__notion-search", "mcp__notion__notion-fetch"]);
  });

  it("exposes the provider tool catalog once a plugin skill is active", async () => {
    const plugin = buildPlugin("notion");
    listToolsMock.mockResolvedValue([
      {
        name: "notion-search",
        title: "Search",
        description: "Search Notion",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "notion-fetch",
        title: "Fetch",
        description: "Fetch Notion content",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "notion-create-pages",
        title: "Create",
        description: "Create Notion pages",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const manager = new McpToolManager([plugin]);
    const activeSkills = [
      {
        name: "notion",
        pluginProvider: "notion",
      },
    ];

    await manager.activateForSkill(activeSkills[0]!);

    expect(
      manager.getActiveToolCatalog(activeSkills).map((tool) => tool.name),
    ).toEqual([
      "mcp__notion__notion-search",
      "mcp__notion__notion-fetch",
      "mcp__notion__notion-create-pages",
    ]);
    expect(
      manager.searchTools(activeSkills, "fetch").map((tool) => tool.name),
    ).toEqual(["mcp__notion__notion-fetch"]);
    const createPagesTool = manager
      .getResolvedActiveTools(activeSkills)
      .find((t) => t.name === "mcp__notion__notion-create-pages");
    await expect(createPagesTool!.execute({})).resolves.toMatchObject({
      details: {
        provider: "notion",
        tool: "notion-create-pages",
      },
    });
  });

  it("fails activation when an allowlisted MCP tool is missing", async () => {
    const plugin = buildPlugin("notion", {
      allowedTools: ["notion-search", "notion-fetch"],
    });
    listToolsMock.mockResolvedValue([
      {
        name: "notion-search",
        title: "Search",
        description: "Search Notion",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const manager = new McpToolManager([plugin]);

    await expect(manager.activateProvider("notion")).rejects.toThrow(
      "Plugin notion MCP discovery missing allowlisted tools: notion-fetch",
    );
  });
});
