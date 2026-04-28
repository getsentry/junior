import { describe, expect, it, vi } from "vitest";
import type { McpToolManager } from "@/chat/mcp/tool-manager";
import type { Skill } from "@/chat/skills";
import { createCallMcpToolTool } from "@/chat/tools/skill/call-mcp-tool";

const activeSkill: Skill = {
  name: "demo",
  description: "Demo skill",
  skillPath: "/tmp/demo",
  pluginProvider: "demo",
  body: "instructions",
};

describe("callMcpTool", () => {
  it("executes an active MCP tool by disclosed tool_name", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "pong" }],
      details: { ok: true },
    }));
    const manager = {
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
    } as unknown as McpToolManager;
    const callMcpTool = createCallMcpToolTool(manager, () => [activeSkill]);

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
      details: { ok: true },
    });
    expect(execute).toHaveBeenCalledWith({ query: "hello" });
  });

  it("rejects top-level MCP arguments instead of silently dropping them", async () => {
    const manager = {
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
    } as unknown as McpToolManager;
    const callMcpTool = createCallMcpToolTool(manager, () => [activeSkill]);

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
      details: { ok: true },
    }));
    const manager = {
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
    } as unknown as McpToolManager;
    const callMcpTool = createCallMcpToolTool(manager, () => [activeSkill]);

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
    } as unknown as McpToolManager;
    const callMcpTool = createCallMcpToolTool(manager, () => [activeSkill]);

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
      getResolvedActiveTools: vi.fn(() => []),
    } as unknown as McpToolManager;
    const callMcpTool = createCallMcpToolTool(manager, () => [activeSkill]);

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
