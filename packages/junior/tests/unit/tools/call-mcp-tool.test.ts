import { describe, expect, it, vi } from "vitest";
import { McpToolError } from "@/chat/mcp/errors";
import { createCallMcpToolTool } from "@/chat/tools/skill/call-mcp-tool";
import type { ManagedMcpTool } from "@/chat/mcp/tool-manager";

type CallMcpTool = ReturnType<typeof createCallMcpToolTool>;
type CallMcpToolInput = Parameters<NonNullable<CallMcpTool["execute"]>>[0];
type CallMcpToolManager = Parameters<typeof createCallMcpToolTool>[0];
type ManagedMcpToolResult = Awaited<ReturnType<ManagedMcpTool["execute"]>>;

function textResult(
  overrides: Partial<ManagedMcpToolResult["details"]> = {},
): ManagedMcpToolResult {
  const provider = overrides.provider ?? "demo";
  const tool = overrides.tool ?? "ping";
  return {
    content: [{ type: "text" as const, text: "pong" }],
    details: {
      provider,
      tool,
      rawResult: {
        content: [{ type: "text" as const, text: "pong" }],
        isError: false,
      },
      ...overrides,
    },
  };
}

function mcpTool(overrides: Partial<ManagedMcpTool> = {}): ManagedMcpTool {
  return {
    name: "mcp__demo__ping",
    rawName: "ping",
    provider: "demo",
    description: "Ping",
    parameters: {},
    execute: vi.fn(async () => textResult()),
    ...overrides,
  };
}

function mcpManager(tools: ManagedMcpTool[]): CallMcpToolManager {
  return {
    activateProvider: vi.fn(async () => true),
    getResolvedActiveTools: vi.fn(() => tools),
  };
}

function requireExecute(tool: CallMcpTool) {
  const execute = tool.execute;
  if (!execute) {
    throw new Error("callMcpTool execute function missing");
  }
  return execute;
}

async function executeCallMcpTool(tool: CallMcpTool, input: CallMcpToolInput) {
  return await requireExecute(tool)(input, {});
}

async function executeRawCallMcpTool(
  tool: CallMcpTool,
  input: Record<string, unknown>,
) {
  return await requireExecute(tool)(input as CallMcpToolInput, {});
}

describe("callMcpTool", () => {
  it("executes an active MCP tool by disclosed tool_name", async () => {
    const execute = vi.fn(async () => textResult());
    const callMcpTool = createCallMcpToolTool(
      mcpManager([mcpTool({ execute })]),
    );

    await expect(
      executeCallMcpTool(callMcpTool, {
        tool_name: "mcp__demo__ping",
        arguments: { query: "hello" },
      }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "pong" }],
      details: { provider: "demo", tool: "ping" },
    });
    expect(execute).toHaveBeenCalledWith(
      { query: "hello" },
      { conversationPrivacy: "private" },
    );
  });

  it("passes conversation privacy to the managed MCP tool", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "pong" }],
      details: {
        provider: "demo",
        tool: "ping",
        rawResult: {
          content: [{ type: "text" as const, text: "pong" }],
          isError: false,
        },
      },
    }));
    const manager = {
      activateProvider: vi.fn(async () => true),
      getResolvedActiveTools: vi.fn(() => [
        {
          name: "mcp__demo__ping",
          rawName: "ping",
          provider: "demo",
          description: "Ping",
          parameters: {},
          execute,
        },
      ]),
    };
    const callMcpTool = createCallMcpToolTool(manager);

    await callMcpTool.execute!(
      {
        tool_name: "mcp__demo__ping",
        arguments: { query: "hello" },
      },
      { conversationPrivacy: "public" },
    );

    expect(execute).toHaveBeenCalledWith(
      { query: "hello" },
      { conversationPrivacy: "public" },
    );
  });

  it.each([
    {
      name: "top-level MCP arguments",
      input: {
        tool_name: "mcp__demo__ping",
        query: "hello",
      },
      message: "callMcpTool MCP arguments must be nested under arguments",
    },
    {
      name: "mixed top-level and nested MCP arguments",
      input: {
        tool_name: "mcp__demo__ping",
        query: "ignored",
        arguments: { query: "hello" },
      },
      message: "callMcpTool MCP arguments must be nested under arguments",
    },
    {
      name: "non-object nested MCP arguments",
      input: {
        tool_name: "mcp__demo__ping",
        arguments: "hello",
      },
      message: "callMcpTool arguments must be an object",
    },
  ])("rejects $name", async ({ input, message }) => {
    const execute = vi.fn(async () => textResult());
    const callMcpTool = createCallMcpToolTool(
      mcpManager([mcpTool({ execute })]),
    );

    await expect(executeRawCallMcpTool(callMcpTool, input)).rejects.toThrow(
      message,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns an expected MCP error when a resumed catalog is missing the requested tool", async () => {
    const manager = mcpManager([
      mcpTool({
        name: "mcp__demo__other",
        rawName: "other",
        description: "Other",
      }),
    ]);
    const callMcpTool = createCallMcpToolTool(manager);

    let error: unknown;
    try {
      await executeCallMcpTool(callMcpTool, {
        tool_name: "mcp__demo__missing_after_resume",
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(McpToolError);
    if (!(error instanceof Error)) {
      throw new Error("expected callMcpTool to throw an error");
    }
    expect(error.message).toContain(
      'Call searchMcpTools with provider "demo" to refresh the catalog',
    );
    expect(manager.activateProvider).toHaveBeenCalledWith("demo");
  });
});
