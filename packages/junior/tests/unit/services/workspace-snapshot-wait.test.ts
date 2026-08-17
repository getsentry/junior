import { describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  continueWorkspaceSnapshotWait,
  pendingWorkspaceSnapshotWait,
} from "@/chat/services/workspace-snapshot-wait";

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
        waiting: "workspace_snapshot",
        timed_out: true,
      },
    },
  ];
}

describe("workspace snapshot wait continuation", () => {
  it("detects a soft wait tool result", () => {
    expect(pendingWorkspaceSnapshotWait(waitingMessages())).toEqual({
      name: "sentry",
    });
  });

  it("host-continues switchWorkspace until ready", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "still building" }],
        details: {
          workspace: { name: "sentry" },
          waiting: "workspace_snapshot",
          timed_out: true,
        },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "ready" }],
        details: {
          workspace: { name: "sentry", id: "ws-1" },
        },
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

    const first = await continueWorkspaceSnapshotWait({
      messages: waitingMessages(),
      tools: tools as never,
    });
    expect(first.kind).toBe("waiting");
    expect(execute).toHaveBeenCalledTimes(1);

    const second = await continueWorkspaceSnapshotWait({
      messages: first.kind === "none" ? waitingMessages() : first.messages,
      tools: tools as never,
    });
    expect(second.kind).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
