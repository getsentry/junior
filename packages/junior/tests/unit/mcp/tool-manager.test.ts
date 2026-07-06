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
    const manager = new McpToolManager([plugin]);

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
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);

    await manager.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(clientOptions).not.toContainEqual(
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
    expect(manager.getActiveToolCatalog()).toEqual([]);
  });

  it("throws expected MCP tool errors", async () => {
    const plugin = buildPlugin();
    const manager = new McpToolManager([plugin]);
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

  it("keeps native MCP image content without duplicating text content", async () => {
    const plugin = buildPlugin();
    const manager = new McpToolManager([plugin]);
    await manager.activateProvider("demo");
    callToolMock.mockResolvedValueOnce({
      content: [
        { type: "text", text: "image generated" },
        { type: "image", data: "base64-image", mimeType: "image/png" },
      ],
      isError: false,
    });

    const result = await manager.getResolvedActiveTools()[0]!.execute({});

    expect(result.content).toEqual([
      { type: "text", text: "image generated" },
      {
        type: "image",
        data: "base64-image",
        mimeType: "image/png",
      },
    ]);

    await manager.close();
  });

  it("uses MCP structuredContent as model-visible text when no image content is present", async () => {
    const plugin = buildPlugin();
    const manager = new McpToolManager([plugin]);
    await manager.activateProvider("demo");
    callToolMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "raw text" }],
      structuredContent: {
        count: 2,
        values: ["alpha", "beta"],
      },
      isError: false,
    });

    const result = await manager.getResolvedActiveTools()[0]!.execute({});

    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(
          {
            count: 2,
            values: ["alpha", "beta"],
          },
          null,
          2,
        ),
      },
    ]);
    await manager.close();
  });

  it("surfaces MCP authorization challenges through the callback hook", async () => {
    const plugin = buildPlugin();
    const manager = new McpToolManager([plugin], {
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
    const manager = new McpToolManager([plugin], {
      onAuthorizationRequired: onAuthorizationRequiredMock,
    });
    await manager.activateProvider("demo");
    callToolMock.mockRejectedValueOnce(
      new McpAuthorizationRequiredError("demo", "Auth required"),
    );

    const resolvedTools = manager.getResolvedActiveTools();
    await expect(resolvedTools[0]!.execute({})).resolves.toMatchObject({
      content: [{ type: "text", text: "Authorization pending." }],
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
    expect(manager.getActiveToolCatalog()).toEqual([]);
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

    expect(manager.getActiveToolCatalog().map((tool) => tool.name)).toEqual([
      "mcp__notion__notion-search",
      "mcp__notion__notion-fetch",
    ]);
  });

  it("exposes the provider tool catalog once a provider is active, without requiring a skill", async () => {
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
    await manager.activateProvider("notion");

    expect(manager.getActiveToolCatalog().map((tool) => tool.name)).toEqual([
      "mcp__notion__notion-search",
      "mcp__notion__notion-fetch",
      "mcp__notion__notion-create-pages",
    ]);
    const createPagesTool = manager
      .getResolvedActiveTools()
      .find((t) => t.name === "mcp__notion__notion-create-pages");
    await expect(createPagesTool!.execute({})).resolves.toEqual({
      content: [{ type: "text", text: "pong" }],
    });
  });

  it("getAvailableProviderCatalog returns all configured providers without connecting", async () => {
    const notionPlugin = buildPlugin("notion");
    const linearPlugin = buildPlugin("linear");
    const manager = new McpToolManager([notionPlugin, linearPlugin]);

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
