import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDefinition } from "@/chat/plugins/types";

const { endAttributes, logWarnMock, resultMock, startAttributes } = vi.hoisted(
  () => ({
    endAttributes: { value: {} as Record<string, unknown> },
    logWarnMock: vi.fn(),
    resultMock: vi.fn(),
    startAttributes: { value: {} as Record<string, unknown> },
  }),
);

vi.mock("@/chat/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/logging")>();
  return {
    ...actual,
    logWarn: logWarnMock,
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
    logWarnMock.mockReset();
    resultMock.mockResolvedValue({
      content: [{ type: "text", text: "private result" }],
      isError: false,
    });
  });

  it("warns when an MCP tool omits behavioral annotations", async () => {
    const manager = new McpToolManager([buildPlugin()]);

    await manager.activateProvider("demo");

    expect(logWarnMock).toHaveBeenCalledWith("mcp.tool_annotations.missing", {
      "app.plugin.name": "demo",
      "gen_ai.tool.name": "inspect",
      "app.tool.missing_annotations":
        "destructiveHint,idempotentHint,openWorldHint,readOnlyHint",
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

  it.each(["private", "public"] as const)(
    "keeps provider tool error text out of %s telemetry",
    async (conversationPrivacy) => {
      const providerText = "SENSITIVE_CANARY";
      resultMock.mockResolvedValue({
        content: [{ type: "text", text: providerText }],
        isError: true,
      });
      const manager = new McpToolManager([buildPlugin()]);
      await manager.activateProvider("demo");
      const [tool] = manager.getResolvedActiveTools();

      await expect(tool!.execute({}, { conversationPrivacy })).rejects.toThrow(
        providerText,
      );

      expect(endAttributes.value["exception.message"]).toBe(
        "MCP tool call failed",
      );
      expect(JSON.stringify(endAttributes.value)).not.toContain(providerText);
    },
  );
});
