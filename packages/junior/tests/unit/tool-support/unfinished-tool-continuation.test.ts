import { describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  continueUnfinishedTool,
  pendingUnfinishedToolContinuation,
} from "@/chat/tool-support/unfinished-tool-continuation";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function waitingMessages(name = "sentry"): PiMessage[] {
  return [
    {
      role: "assistant",
      api: "test",
      provider: "test",
      model: "test",
      content: [
        {
          type: "toolCall",
          id: "tool-1",
          name: "switchWorkspace",
          arguments: { name },
        },
      ],
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "switchWorkspace",
      content: [{ type: "text", text: "waiting" }],
      isError: false,
      timestamp: 2,
      details: {
        workspace: { name },
        unfinished: true,
        continuation: {
          tool_name: "switchWorkspace",
          arguments: { name },
          reason: "workspace snapshot still building",
        },
      },
    },
  ];
}

describe("unfinished tool continuation", () => {
  it("detects an unfinished continuation tool result", () => {
    expect(pendingUnfinishedToolContinuation(waitingMessages())).toEqual({
      toolName: "switchWorkspace",
      arguments: { name: "sentry" },
      reason: "workspace snapshot still building",
    });
  });

  it("ignores timed_out results that lack unfinished", () => {
    expect(
      pendingUnfinishedToolContinuation([
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "bash",
          content: [{ type: "text", text: "timed out" }],
          isError: false,
          timestamp: 1,
          details: {
            timed_out: true,
            target: "pnpm test",
          },
        },
      ]),
    ).toBeNull();
  });

  it("ignores model-facing continuation without unfinished", () => {
    expect(
      pendingUnfinishedToolContinuation([
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "readFile",
          content: [{ type: "text", text: "partial" }],
          isError: false,
          timestamp: 1,
          details: {
            continuation: {
              arguments: { path: "notes.txt", offset: 2, limit: 1 },
            },
          },
        },
      ]),
    ).toBeNull();
  });

  it("detects a wait before sibling tool results", () => {
    expect(
      pendingUnfinishedToolContinuation([
        ...waitingMessages(),
        {
          role: "toolResult",
          toolCallId: "tool-2",
          toolName: "reportProgress",
          content: [{ type: "text", text: "reported" }],
          isError: false,
          timestamp: 3,
          details: { status: "building" },
        },
      ]),
    ).toEqual({
      toolName: "switchWorkspace",
      arguments: { name: "sentry" },
      reason: "workspace snapshot still building",
    });
  });

  it("does not revive an older wait after a newer call of the same tool succeeds", () => {
    expect(
      pendingUnfinishedToolContinuation([
        ...waitingMessages("old-workspace"),
        {
          role: "toolResult",
          toolCallId: "tool-2",
          toolName: "switchWorkspace",
          content: [{ type: "text", text: "ready" }],
          isError: false,
          timestamp: 3,
          details: {
            workspace: { id: "workspace-2", name: "new-workspace" },
          },
        },
      ]),
    ).toBeNull();
  });

  it("continues the same tool from tool-result boundaries until ready", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "still building" }],
        details: {
          workspace: { name: "sentry" },
          unfinished: true,
          continuation: {
            arguments: { name: "sentry" },
            reason: "workspace snapshot still building",
          },
        },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "ready" }],
        details: { workspace: { name: "sentry", id: "ws-1" } },
      });
    const tools = [
      {
        name: "switchWorkspace",
        label: "switchWorkspace",
        description: "switch",
        parameters: {} as never,
        execute,
      },
    ];

    const first = await continueUnfinishedTool({
      messages: waitingMessages(),
      tools: tools as never,
    });
    expect(first.kind).toBe("waiting");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith(
      expect.any(String),
      { name: "sentry" },
      undefined,
    );

    const second = await continueUnfinishedTool({
      messages: first.kind === "none" ? waitingMessages() : first.messages,
      tools: tools as never,
    });
    expect(second.kind).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps a valid tool-result boundary when host continuation fails", async () => {
    const error = new Error("Workspace was deleted");
    const failed = await continueUnfinishedTool({
      messages: waitingMessages(),
      tools: [
        {
          name: "switchWorkspace",
          label: "switchWorkspace",
          description: "switch",
          parameters: {} as never,
          execute: vi.fn().mockRejectedValue(error),
        },
      ] as never,
    });

    expect(failed).toMatchObject({ kind: "failed", error });
    if (failed.kind !== "failed") throw new Error("Expected failed result");
    expect(failed.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "switchWorkspace",
      isError: true,
      details: { error: "Workspace was deleted" },
    });
  });
});
