import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/queue/types";

const { processQueuedThreadMessageMock, callbackTopicRef, logInfoMock } =
  vi.hoisted(() => ({
    processQueuedThreadMessageMock: vi.fn(async () => undefined),
    callbackTopicRef: { value: "junior-thread-message" },
    logInfoMock: vi.fn(),
  }));

vi.mock("@/chat/queue/process-thread-message", () => ({
  processQueuedThreadMessage: processQueuedThreadMessageMock,
}));

vi.mock("@/chat/observability", () => ({
  createRequestContext: vi.fn(
    (_request: Request, context?: Record<string, unknown>) => context ?? {},
  ),
  logError: vi.fn(),
  logException: vi.fn(),
  logInfo: logInfoMock,
  setSpanStatus: vi.fn(),
  withContext: vi.fn(
    async (_context: unknown, callback: () => Promise<unknown>) =>
      await callback(),
  ),
  withSpan: vi.fn(
    async (
      _name: string,
      _op: string,
      _context: unknown,
      callback: () => Promise<unknown>,
    ) => await callback(),
  ),
}));

vi.mock("@/chat/queue/client", () => ({
  getThreadMessageTopic: () => "junior-thread-message",
  createQueueCallbackHandler:
    (
      handler: (
        payload: ThreadMessagePayload,
        meta: { messageId: string; deliveryCount: number; topicName: string },
      ) => Promise<void>,
    ) =>
    async (_request: Request) => {
      const payload: ThreadMessagePayload = {
        dedupKey: "slack:C123:1700000000.100:1700000000.200",
        kind: "new_mention",
        normalizedThreadId: "slack:C123:1700000000.100",
        thread: {
          _type: "chat:Thread",
          id: "slack:C123:1700000000.100",
          channelId: "C123",
          adapterName: "slack",
          isDM: false,
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
            isMe: false,
          },
          attachments: [],
          metadata: { dateSent: new Date().toISOString(), edited: false },
        },
      };

      await handler(payload, {
        messageId: "msg_123",
        deliveryCount: 1,
        topicName: callbackTopicRef.value,
      });

      return new Response("ok", { status: 202 });
    },
}));

import { POST } from "@/handlers/queue-callback";

describe("queue callback route", () => {
  beforeEach(() => {
    processQueuedThreadMessageMock.mockClear();
    callbackTopicRef.value = "junior-thread-message";
    logInfoMock.mockClear();
  });

  it("processes queue callback payloads and injects queueMessageId", async () => {
    const response = await POST(
      new Request("http://localhost/api/queue/callback", { method: "POST" }),
    );

    expect(response.status).toBe(202);
    expect(processQueuedThreadMessageMock).toHaveBeenCalledTimes(1);
    expect(processQueuedThreadMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "slack:C123:1700000000.100:1700000000.200",
        queueMessageId: "msg_123",
      }),
    );
    expect(logInfoMock).toHaveBeenCalledWith(
      "queue_callback_received",
      expect.objectContaining({
        slackThreadId: "slack:C123:1700000000.100",
        slackChannelId: "C123",
        slackUserId: "U_TEST",
      }),
      expect.objectContaining({
        "messaging.message.id": "1700000000.200",
        "app.queue.message_id": "msg_123",
        "app.queue.delivery_count": 1,
        "app.queue.topic": "junior-thread-message",
      }),
      "Received queue callback payload",
    );
  });

  it("rejects callback payloads from unexpected topics", async () => {
    callbackTopicRef.value = "unexpected-topic";

    await expect(
      POST(
        new Request("http://localhost/api/queue/callback", { method: "POST" }),
      ),
    ).rejects.toThrow("Unexpected queue topic: unexpected-topic");
    expect(processQueuedThreadMessageMock).not.toHaveBeenCalled();
  });
});
