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
  options: { allowedTools?: string[]; wrappedTools?: string[] } = {},
): PluginDefinition {
  return {
    dir: `/tmp/plugins/${name}`,
    skillsDir: `/tmp/plugins/${name}/skills`,
    manifest: {
      name,
      displayName: "Demo",
      description: "Demo MCP plugin",
      configKeys: [],
      mcp: {
        transport: "http",
        url: "https://mcp.example.com",
        ...(options.allowedTools ? { allowedTools: options.allowedTools } : undefined),
        ...(options.wrappedTools ? { wrappedTools: options.wrappedTools } : undefined),
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
        annotations: {
          destructiveHint: false,
          openWorldHint: true,
          readOnlyHint: true,
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

    expect(await manager.activateProvider("demo")).toBe(true);
    expect(await manager.activateProvider("demo")).toBe(false);
    expect(manager.getActiveProviders()).toEqual(["demo"]);

    const tools = manager.getActiveToolCatalog();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("mcp__demo__ping");
    expect(tools[0]?.rawName).toBe("ping");
    expect(tools[0]?.description).toBe("[demo] Ping the remote MCP server");
    expect(tools[0]?.annotations).toEqual({
      destructiveHint: false,
      openWorldHint: true,
      readOnlyHint: true,
    });

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

  it("creates one provider client across concurrent activations", async () => {
    let finishProvider: (() => void) | undefined;
    const authProviderFactory = vi.fn(
      async () =>
        await new Promise<undefined>((resolve) => {
          finishProvider = () => resolve(undefined);
        }),
    );
    const manager = new McpToolManager([buildPlugin()], {
      authProviderFactory,
    });

    const first = manager.activateProvider("demo");
    const second = manager.activateProvider("demo");

    await vi.waitFor(() =>
      expect(authProviderFactory).toHaveBeenCalledTimes(1),
    );
    finishProvider?.();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(clientOptions).toHaveLength(1);
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

  it("middle-truncates oversized MCP output before exposing it to the model", async () => {
    const plugin = buildPlugin();
    const manager = new McpToolManager([plugin]);
    await manager.activateProvider("demo");
    const head = "head:" + "a".repeat(40_000);
    const tail = "z".repeat(40_000) + ":tail";
    callToolMock.mockResolvedValueOnce({
      content: [{ type: "text", text: `${head}${tail}` }],
      isError: false,
    });

    const result = await manager.getResolvedActiveTools()[0]!.execute({});
    const text = result.content[0];

    expect(text).toMatchObject({ type: "text" });
    if (text?.type !== "text") {
      throw new Error("expected bounded text content");
    }
    expect(Buffer.byteLength(text.text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(text.text).toContain(
      "Warning: truncated output (original token count: 20003; original bytes: 80010)",
    );
    expect(text.text).toMatch(/^head:/);
    expect(text.text).toMatch(/:tail$/);
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
      providerContent: [{ type: "text", text: "pong" }],
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

  it("invokes onToolSuccess after a successful model-facing MCP call", async () => {
    const plugin = buildPlugin();
    const onToolSuccess = vi.fn(async () => undefined);
    listToolsMock.mockResolvedValue([
      {
        name: "save_issue",
        description: "Create or update an issue",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: "Created ENG-123" }],
      structuredContent: { identifier: "ENG-123" },
      isError: false,
    });
    const manager = new McpToolManager([plugin], { onToolSuccess });
    await manager.activateProvider("demo");

    await manager.getResolvedActiveTools()[0]!.execute({
      title: "Created via MCP",
    });

    expect(onToolSuccess).toHaveBeenCalledWith({
      arguments: { title: "Created via MCP" },
      provider: "demo",
      structuredContent: { identifier: "ENG-123" },
      toolName: "save_issue",
    });
    await manager.close();
  });

  it("hides wrapped tools from discovery but keeps them callable", async () => {
    const plugin = buildPlugin("linear", {
      allowedTools: ["get_issue"],
      wrappedTools: ["create_issue"],
    });
    listToolsMock.mockResolvedValue([
      {
        name: "create_issue",
        description: "Create an issue",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_issue",
        description: "Get an issue",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "delete_issue",
        description: "Delete an issue",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: "ENG-123" }],
      structuredContent: { identifier: "ENG-123" },
      isError: false,
    });
    const manager = new McpToolManager([plugin]);

    await manager.activateProvider("linear");

    expect(manager.getActiveToolCatalog()).toMatchObject([
      { provider: "linear", rawName: "get_issue" },
    ]);
    await expect(
      manager.callWrappedTool("linear", "create_issue", {
        team: "Engineering",
        title: "Wrapped issue",
      }),
    ).resolves.toMatchObject({
      status: "success",
      content: [{ type: "text", text: "ENG-123" }],
      structuredContent: { identifier: "ENG-123" },
    });
    await expect(
      manager.callWrappedTool("linear", "get_issue", {}),
    ).rejects.toThrow("cannot call unwrapped MCP tool get_issue");
  });

  it("marks handled authorization challenges during wrapped tool calls", async () => {
    const plugin = buildPlugin("linear", { wrappedTools: ["create_issue"] });
    listToolsMock.mockResolvedValue([
      {
        name: "create_issue",
        description: "Create an issue",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const authError = new McpAuthorizationRequiredError(
      "linear",
      "authorization required",
    );
    callToolMock.mockRejectedValue(authError);
    onAuthorizationRequiredMock.mockResolvedValue(true);
    const manager = new McpToolManager([plugin], {
      onAuthorizationRequired: onAuthorizationRequiredMock,
    });
    await manager.activateProvider("linear");

    await expect(
      manager.callWrappedTool("linear", "create_issue", {}),
    ).resolves.toEqual({
      status: "authorization_pending",
    });
    expect(manager.getActiveProviders()).toEqual([]);
  });

  it("returns definitive provider rejections to wrapped tools", async () => {
    const plugin = buildPlugin("linear", { wrappedTools: ["create_issue"] });
    listToolsMock.mockResolvedValue([
      {
        name: "create_issue",
        description: "Create an issue",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: "Team is invalid" }],
      isError: true,
    });
    const manager = new McpToolManager([plugin]);
    await manager.activateProvider("linear");

    await expect(
      manager.callWrappedTool("linear", "create_issue", {}),
    ).resolves.toEqual({
      status: "error",
      message: "Team is invalid",
    });
  });

  it("fails activation when a wrapped MCP tool is missing", async () => {
    const plugin = buildPlugin("linear", { wrappedTools: ["create_issue"] });
    const manager = new McpToolManager([plugin]);

    await expect(manager.activateProvider("linear")).rejects.toThrow(
      "Plugin linear MCP discovery missing wrapped tools: create_issue",
    );
  });
});
