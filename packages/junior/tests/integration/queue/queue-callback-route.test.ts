import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuePayload, ThreadMessagePayload } from "@/chat/queue/types";

const {
  processQueuedThreadMessageMock,
  processSubagentTaskMock,
  callbackTopicRef
} = vi.hoisted(() => ({
  processQueuedThreadMessageMock: vi.fn(async () => undefined),
  processSubagentTaskMock: vi.fn(async () => undefined),
  callbackTopicRef: { value: "junior-thread-message" }
}));

vi.mock("@/chat/queue/process-thread-message", () => ({
  processQueuedThreadMessage: processQueuedThreadMessageMock
}));

vi.mock("@/chat/subagent/process-task", () => ({
  processSubagentTask: processSubagentTaskMock
}));

vi.mock("@/chat/queue/client", () => ({
  getThreadMessageTopic: () => "junior-thread-message",
  getSubagentTaskTopic: () => "junior-subagent-task",
  createQueueCallbackHandler:
    (handler: (payload: QueuePayload, meta: { messageId: string; deliveryCount: number; topicName: string }) => Promise<void>) =>
    async (_request: Request) => {
      const threadPayload: ThreadMessagePayload = {
        dedupKey: "slack:C123:1700000000.100:1700000000.200",
        kind: "new_mention",
        normalizedThreadId: "slack:C123:1700000000.100",
        thread: {
          _type: "chat:Thread",
          id: "slack:C123:1700000000.100",
          channelId: "C123",
          adapterName: "slack",
          isDM: false
        },
        message: {
          _type: "chat:Message",
          id: "1700000000.200",
          threadId: "slack:C123:1700000000.100",
          text: "hello",
          formatted: { type: "root", children: [] },
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
        }
      };
      const payload: QueuePayload = callbackTopicRef.value === "junior-subagent-task"
        ? {
            callKey: "conv-1:turn-1:tool-1",
            conversationId: "conv-1",
            sessionId: "turn-1",
            task: "hello",
            queueContext: {
              dedupKey: threadPayload.dedupKey,
              normalizedThreadId: threadPayload.normalizedThreadId,
              message: threadPayload.message,
              thread: threadPayload.thread
            }
          }
        : threadPayload;

      await handler(payload, {
        messageId: "msg_123",
        deliveryCount: 1,
        topicName: callbackTopicRef.value
      });

      return new Response("ok", { status: 202 });
    }
}));

import { POST } from "@/handlers/queue-callback";

describe("queue callback route", () => {
  beforeEach(() => {
    processQueuedThreadMessageMock.mockClear();
    processSubagentTaskMock.mockClear();
    callbackTopicRef.value = "junior-thread-message";
  });

  it("processes queue callback payloads and injects queueMessageId", async () => {
    const response = await POST(new Request("http://localhost/api/queue/callback", { method: "POST" }));

    expect(response.status).toBe(202);
    expect(processQueuedThreadMessageMock).toHaveBeenCalledTimes(1);
    expect(processQueuedThreadMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "slack:C123:1700000000.100:1700000000.200",
        queueMessageId: "msg_123"
      })
    );
  });

  it("rejects callback payloads from unexpected topics", async () => {
    callbackTopicRef.value = "unexpected-topic";

    await expect(POST(new Request("http://localhost/api/queue/callback", { method: "POST" }))).rejects.toThrow(
      "Unexpected queue topic: unexpected-topic"
    );
    expect(processQueuedThreadMessageMock).not.toHaveBeenCalled();
  });

  it("processes subagent task topic payloads", async () => {
    callbackTopicRef.value = "junior-subagent-task";

    await POST(new Request("http://localhost/api/queue/callback", { method: "POST" }));

    expect(processSubagentTaskMock).toHaveBeenCalledTimes(1);
    expect(processQueuedThreadMessageMock).not.toHaveBeenCalled();
  });
});
