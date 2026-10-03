import { describe, expect, it, vi } from "vitest";
import type { PluginMcp } from "@sentry/junior-plugin-api";
import { hexPlugin } from "../src/index";

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

function tool(mcp: PluginMcp) {
  const definition = hexPlugin().hooks?.tools?.({
    mcp,
  } as never).waitForHexThread;
  if (!definition?.execute) throw new Error("Hex wait tool is missing");
  return definition.execute;
}

describe("Hex Thread wait", () => {
  it("waits for completed results within one model tool call", async () => {
    const callTool = vi
      .fn<PluginMcp["callTool"]>()
      .mockResolvedValueOnce({
        status: "success",
        structuredContent: { status: "RUNNING" },
        content: [{ type: "text", text: "Thread status: RUNNING" }],
      })
      .mockResolvedValueOnce({
        status: "success",
        structuredContent: { status: "IDLE" },
        content: [{ type: "text", text: "Total: 123" }],
      });
    const result = tool({ callTool, prepare: async () => "ready" })(
      { threadId: "thread-123" },
      {},
    );
    await expect(result).resolves.toMatchObject({
      details: { threadId: "thread-123", polls: 2, status: "complete" },
      content: [
        { type: "text", text: expect.stringContaining("complete") },
        { type: "text", text: "Total: 123" },
      ],
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenCalledWith({
      name: "get_thread",
      arguments: { thread_id: "thread-123" },
    });
  });

  it("stops on an unknown response rather than making more provider calls", async () => {
    const callTool = vi.fn<PluginMcp["callTool"]>().mockResolvedValue({
      status: "success",
      content: [{ type: "text", text: "Hex response changed" }],
    });
    await expect(
      tool({ callTool, prepare: async () => "ready" })(
        { threadId: "thread-123" },
        {},
      ),
    ).resolves.toMatchObject({
      details: { status: "unknown", polls: 1 },
      content: [
        { type: "text", text: expect.any(String) },
        { type: "text", text: "Hex response changed" },
      ],
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
