import { describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  continueTimedOutTool,
  pendingTimedOutToolContinuation,
} from "@/chat/tool-support/timed-out-tool-continuation";

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
        timed_out: true,
        continuation: {
          tool_name: "switchWorkspace",
          arguments: { name },
          reason: "workspace snapshot still building",
        },
      },
    },
  ];
}

describe("timed-out tool continuation", () => {
  it("detects a timed_out continuation tool result", () => {
    expect(pendingTimedOutToolContinuation(waitingMessages())).toEqual({
      toolName: "switchWorkspace",
      arguments: { name: "sentry" },
      reason: "workspace snapshot still building",
    });
  });

  it("detects a wait before sibling tool results", () => {
    expect(
      pendingTimedOutToolContinuation([
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
      pendingTimedOutToolContinuation([
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
          timed_out: true,
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

    const first = await continueTimedOutTool({
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

    const second = await continueTimedOutTool({
      messages: first.kind === "none" ? waitingMessages() : first.messages,
      tools: tools as never,
    });
    expect(second.kind).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps a valid tool-result boundary when host continuation fails", async () => {
    const error = new Error("Workspace was deleted");
    const failed = await continueTimedOutTool({
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
