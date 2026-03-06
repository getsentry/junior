import { beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableTurnError } from "@/chat/turn/errors";
import type { ToolCallOptions } from "@/chat/tools/definition";

const {
  getSubagentTaskRecordMock,
  upsertSubagentTaskRecordMock,
  enqueueSubagentTaskMock
} = vi.hoisted(() => ({
  getSubagentTaskRecordMock: vi.fn(),
  upsertSubagentTaskRecordMock: vi.fn(async () => undefined),
  enqueueSubagentTaskMock: vi.fn(async () => "subagent-msg-1")
}));

vi.mock("@/chat/state", () => ({
  getSubagentTaskRecord: getSubagentTaskRecordMock,
  upsertSubagentTaskRecord: upsertSubagentTaskRecordMock
}));

vi.mock("@/chat/queue/client", () => ({
  enqueueSubagentTask: enqueueSubagentTaskMock
}));

import { createTaskSubagentTool } from "@/chat/tools/task-subagent";

function baseOptions(): ToolCallOptions {
  const queueContext = {
    dedupKey: "slack:C123:1700000000.100:1700000000.200",
    normalizedThreadId: "slack:C123:1700000000.100",
    message: {
      _type: "chat:Message" as const,
      id: "1700000000.200",
      threadId: "slack:C123:1700000000.100",
      text: "hello",
      formatted: { type: "root" as const, children: [] },
      raw: "hello",
      author: {
        userId: "U_TEST",
        userName: "test-user",
        fullName: "Test User",
        isBot: false,
        isMe: false
      },
      attachments: [],
      metadata: { dateSent: new Date().toISOString(), edited: false }
    },
    thread: {
      _type: "chat:Thread" as const,
      id: "slack:C123:1700000000.100",
      channelId: "C123",
      adapterName: "slack",
      isDM: false
    }
  };

  return {
    conversationId: "conv-1",
    sessionId: "turn-1",
    toolCallId: "tool-1",
    queueContext
  } satisfies ToolCallOptions;
}

describe("taskSubagent tool", () => {
  beforeEach(() => {
    getSubagentTaskRecordMock.mockReset();
    upsertSubagentTaskRecordMock.mockReset();
    enqueueSubagentTaskMock.mockReset();
    upsertSubagentTaskRecordMock.mockResolvedValue(undefined);
    enqueueSubagentTaskMock.mockResolvedValue("subagent-msg-1");
  });

  it("returns completed result when subagent record is complete", async () => {
    getSubagentTaskRecordMock.mockResolvedValue({
      status: "completed",
      resultText: "done"
    });

    const tool = createTaskSubagentTool();
    const result = await tool.execute?.({ task: "summarize this" }, baseOptions());

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        status: "completed",
        output: "done"
      })
    );
    expect(enqueueSubagentTaskMock).not.toHaveBeenCalled();
  });

  it("enqueues a new subagent task and defers parent turn", async () => {
    getSubagentTaskRecordMock.mockResolvedValue(undefined);

    const tool = createTaskSubagentTool();
    await expect(tool.execute?.({ task: "summarize this" }, baseOptions())).rejects.toBeInstanceOf(
      RetryableTurnError
    );

    expect(upsertSubagentTaskRecordMock).toHaveBeenCalledTimes(1);
    expect(enqueueSubagentTaskMock).toHaveBeenCalledTimes(1);
  });

  it("defers when an existing subagent task is still pending", async () => {
    getSubagentTaskRecordMock.mockResolvedValue({
      status: "running"
    });

    const tool = createTaskSubagentTool();
    await expect(tool.execute?.({ task: "summarize this" }, baseOptions())).rejects.toBeInstanceOf(
      RetryableTurnError
    );

    expect(enqueueSubagentTaskMock).not.toHaveBeenCalled();
  });
});
