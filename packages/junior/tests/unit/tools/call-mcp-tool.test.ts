import { describe, expect, it, vi } from "vitest";
import { McpToolError } from "@/chat/mcp/errors";
import { createCallMcpToolTool } from "@/chat/tools/skill/call-mcp-tool";

describe("callMcpTool", () => {
  it("executes an active MCP tool by disclosed tool_name", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "pong" }],
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
    });
    expect(execute).toHaveBeenCalledWith(
      { query: "hello" },
      { conversationPrivacy: "private" },
    );
  });

  it("advertises nested MCP arguments as an object", () => {
    const manager = {
      activateProvider: vi.fn(async () => true),
      getResolvedActiveTools: vi.fn(() => []),
    };
    const callMcpTool = createCallMcpToolTool(manager);

    expect(callMcpTool.inputSchema).toMatchObject({
      properties: {
        arguments: {
          type: "object",
        },
      },
    });
  });

  it("preserves native MCP content from the managed tool", async () => {
    const nativeContent = [
      { type: "text" as const, text: "image generated" },
      {
        type: "image" as const,
        data: "base64-image",
        mimeType: "image/png",
      },
    ];
    const execute = vi.fn(async () => ({
      content: nativeContent,
    }));
    const manager = {
      activateProvider: vi.fn(async () => true),
      getResolvedActiveTools: vi.fn(() => [
        {
          name: "mcp__demo__image",
          rawName: "image",
          provider: "demo",
          description: "Image",
          parameters: {},
          execute,
        },
      ]),
    };
    const callMcpTool = createCallMcpToolTool(manager);

    await expect(
      callMcpTool.execute!(
        {
          tool_name: "mcp__demo__image",
          arguments: {},
        },
        {},
      ),
    ).resolves.toEqual({
      content: nativeContent,
    });
  });

  it("passes conversation privacy to the managed MCP tool", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "pong" }],
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

  it("returns an expected MCP error when a resumed catalog is missing the requested tool", async () => {
    const manager = {
      activateProvider: vi.fn(async () => true),
      getResolvedActiveTools: vi.fn(() => [
        {
          name: "mcp__demo__other",
          rawName: "other",
          provider: "demo",
          description: "Other",
          parameters: {},
          execute: vi.fn(),
        },
      ]),
    };
    const callMcpTool = createCallMcpToolTool(manager);

    let error: unknown;
    try {
      await callMcpTool.execute!(
        {
          tool_name: "mcp__demo__missing_after_resume",
        },
        {},
      );
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
