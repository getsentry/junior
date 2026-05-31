import { describe, expect, it, vi } from "vitest";
import { createCallMcpToolTool } from "@/chat/tools/skill/call-mcp-tool";

describe("callMcpTool", () => {
  it("executes an active MCP tool by disclosed tool_name", async () => {
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

    await expect(
      callMcpTool.execute!(
        {
          tool_name: "mcp__demo__ping",
          arguments: { query: "hello" },
        },
        {},
      ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "pong" }],
      details: { provider: "demo", tool: "ping" },
    });
    expect(execute).toHaveBeenCalledWith({ query: "hello" });
  });

  it("rejects top-level MCP arguments instead of silently dropping them", async () => {
    const manager = {
      activateProvider: vi.fn(async () => true),
      getResolvedActiveTools: vi.fn(() => [
        {
          name: "mcp__demo__ping",
          rawName: "ping",
          provider: "demo",
          description: "Ping",
          parameters: {},
          execute: vi.fn(),
        },
      ]),
    };
    const callMcpTool = createCallMcpToolTool(manager);

    await expect(
      callMcpTool.execute!(
        {
          tool_name: "mcp__demo__ping",
          query: "hello",
        } as never,
        {},
      ),
    ).rejects.toThrow(
      "callMcpTool MCP arguments must be nested under arguments",
    );
  });

  it("rejects ambiguous mixed top-level and nested MCP arguments", async () => {
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

    await expect(
      callMcpTool.execute!(
        {
          tool_name: "mcp__demo__ping",
          query: "ignored",
          arguments: { query: "hello" },
        } as never,
        {},
      ),
    ).rejects.toThrow(
      "callMcpTool MCP arguments must be nested under arguments",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects non-object nested MCP arguments", async () => {
    const manager = {
      activateProvider: vi.fn(async () => true),
      getResolvedActiveTools: vi.fn(() => [
        {
          name: "mcp__demo__ping",
          rawName: "ping",
          provider: "demo",
          description: "Ping",
          parameters: {},
          execute: vi.fn(),
        },
      ]),
    };
    const callMcpTool = createCallMcpToolTool(manager);

    await expect(
      callMcpTool.execute!(
        {
          tool_name: "mcp__demo__ping",
          arguments: "hello",
        } as never,
        {},
      ),
    ).rejects.toThrow("callMcpTool arguments must be an object");
  });

  it("rejects tools that are not active for the turn", async () => {
    const manager = {
      activateProvider: vi.fn(async () => true),
      getResolvedActiveTools: vi.fn(() => []),
    };
    const callMcpTool = createCallMcpToolTool(manager);

    await expect(
      callMcpTool.execute!(
        {
          tool_name: "mcp__demo__missing",
        },
        {},
      ),
    ).rejects.toThrow("MCP tool is not active for this turn");
  });
});
