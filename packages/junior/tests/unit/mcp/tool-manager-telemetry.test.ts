import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDefinition } from "@/chat/plugins/types";

const { endAttributes, resultMock, startAttributes } = vi.hoisted(() => ({
  endAttributes: { value: {} as Record<string, unknown> },
  resultMock: vi.fn(),
  startAttributes: { value: {} as Record<string, unknown> },
}));

vi.mock("@/chat/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/logging")>();
  return {
    ...actual,
    setSpanAttributes: vi.fn((attributes: Record<string, unknown>) => {
      Object.assign(endAttributes.value, attributes);
    }),
    withSpan: vi.fn(
      async (
        _name: string,
        _op: string,
        _context: unknown,
        callback: () => Promise<unknown>,
        attributes: Record<string, unknown>,
      ) => {
        startAttributes.value = { ...attributes };
        return await callback();
      },
    ),
  };
});

vi.mock("@/chat/mcp/client", () => ({
  McpAuthorizationRequiredError: class McpAuthorizationRequiredError extends Error {},
  PluginMcpClient: class PluginMcpClient {
    async listTools() {
      return [
        {
          name: "inspect",
          description: "Inspect a private value.",
          inputSchema: { type: "object", properties: {} },
        },
      ];
    }

    async callTool() {
      return await resultMock();
    }

    async close() {}
  },
}));

import { McpToolManager } from "@/chat/mcp/tool-manager";

function buildPlugin(): PluginDefinition {
  return {
    dir: "/tmp/plugins/demo",
    skillsDir: "/tmp/plugins/demo/skills",
    manifest: {
      name: "demo",
      displayName: "Demo",
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

describe("McpToolManager telemetry", () => {
  beforeEach(() => {
    startAttributes.value = {};
    endAttributes.value = {};
    resultMock.mockReset();
    resultMock.mockResolvedValue({
      content: [{ type: "text", text: "private result" }],
      isError: false,
    });
  });

  it("reports metadata for private MCP results without exposing content", async () => {
    const manager = new McpToolManager([buildPlugin()]);
    await manager.activateProvider("demo");
    const [tool] = manager.getResolvedActiveTools();

    await tool!.execute({}, { conversationPrivacy: "private" });

    expect(endAttributes.value["gen_ai.tool.call.result"]).toContain(
      '"type":"object"',
    );
    expect(endAttributes.value["gen_ai.tool.call.result"]).not.toContain(
      "private result",
    );
  });
});
