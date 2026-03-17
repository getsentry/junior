import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDefinition } from "@/chat/plugins/types";

const { callToolMock, closeMock, listToolsMock, onAuthorizationRequiredMock } =
  vi.hoisted(() => ({
    callToolMock: vi.fn(),
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
    constructor(private readonly plugin: PluginDefinition) {}

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

function buildPlugin(): PluginDefinition {
  return {
    dir: "/tmp/plugins/demo",
    skillsDir: "/tmp/plugins/demo/skills",
    manifest: {
      name: "demo",
      description: "Demo MCP plugin",
      capabilities: [],
      configKeys: [],
      mcp: {
        transport: "http",
        url: "https://mcp.example.com",
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

    expect(await manager.activateForSkill({ pluginProvider: undefined })).toBe(
      false,
    );
    expect(await manager.activateForSkill({ pluginProvider: "demo" })).toBe(
      true,
    );
    expect(await manager.activateProvider("demo")).toBe(false);
    expect(manager.getActiveProviders()).toEqual(["demo"]);

    const tools = manager.getActiveTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("mcp__demo__ping");
    expect(tools[0]?.description).toBe("[demo] Ping the remote MCP server");

    const result = await tools[0]!.execute("call-1", {
      query: "hello",
    } as never);

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

    const tool = manager.getActiveTools()[0];
    await expect(tool!.execute("call-2", {} as never)).rejects.toBeInstanceOf(
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
});
