import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "chat";

const {
  enqueueThreadMessageMock,
  hasQueueIngressDedupMock,
  claimQueueIngressDedupMock,
  isSubscribedMock
} = vi.hoisted(() => ({
  enqueueThreadMessageMock: vi.fn(async () => "msg_abc123"),
  hasQueueIngressDedupMock: vi.fn(async () => false),
  claimQueueIngressDedupMock: vi.fn(async () => true),
  isSubscribedMock: vi.fn(async () => true)
}));

vi.mock("@/chat/queue/client", () => ({
  enqueueThreadMessage: enqueueThreadMessageMock
}));

vi.mock("@/chat/state", () => ({
  hasQueueIngressDedup: hasQueueIngressDedupMock,
  claimQueueIngressDedup: claimQueueIngressDedupMock,
  getStateAdapter: () => ({
    isSubscribed: isSubscribedMock
  })
}));

import "@/chat/chat-background-patch";

describe("chat background queue enqueue", () => {
  afterEach(() => {
    enqueueThreadMessageMock.mockClear();
    hasQueueIngressDedupMock.mockClear();
    claimQueueIngressDedupMock.mockClear();
    isSubscribedMock.mockClear();
  });

  it("enqueues subscribed messages through default queue routing", async () => {
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const processMessage = (Chat.prototype as unknown as { processMessage: Function }).processMessage;

    const fakeChat = {
      logger: {
        error: vi.fn()
      },
      createThread: vi.fn(async () => ({
        id: "slack:C123:1700000000.100",
        channelId: "C123",
        isDM: false,
        toJSON: () => ({
          _type: "chat:Thread",
          id: "slack:C123:1700000000.100",
          channelId: "C123",
          adapterName: "slack",
          isDM: false
        })
      })),
      detectMention: vi.fn(() => false)
    };

    processMessage.call(
      fakeChat,
      {},
      "slack:C123:1700000000.100",
      {
        id: "1700000000.200",
        text: "hello",
        isMention: false,
        raw: {
          channel: "C123",
          thread_ts: "1700000000.100",
          ts: "1700000000.200"
        },
        toJSON: () => ({
          _type: "chat:Message",
          id: "1700000000.200",
          threadId: "slack:C123:1700000000.100",
          text: "hello",
          formatted: { type: "root", children: [] },
          raw: "hello",
          author: { userId: "U_TEST", isMe: false },
          attachments: [],
          metadata: { dateSent: new Date().toISOString(), edited: false }
        }),
        attachments: [],
        author: {
          userId: "U_TEST",
          isMe: false
        }
      },
      {
        waitUntil(taskFactory: () => Promise<unknown>) {
          waitUntilTasks.push(taskFactory());
        }
      }
    );

    expect(waitUntilTasks).toHaveLength(1);
    await expect(waitUntilTasks[0]).resolves.toBeUndefined();

    expect(isSubscribedMock).toHaveBeenCalledWith("slack:C123:1700000000.100");
    expect(hasQueueIngressDedupMock).toHaveBeenCalledWith("slack:C123:1700000000.100:1700000000.200");

    expect(enqueueThreadMessageMock).toHaveBeenCalledTimes(1);
    expect(enqueueThreadMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "slack:C123:1700000000.100:1700000000.200",
        normalizedThreadId: "slack:C123:1700000000.100",
        kind: "subscribed_message"
      }),
      {
        idempotencyKey: "slack:C123:1700000000.100:1700000000.200"
      }
    );

    expect(claimQueueIngressDedupMock).toHaveBeenCalledWith(
      "slack:C123:1700000000.100:1700000000.200",
      24 * 60 * 60 * 1000
    );
    expect(fakeChat.logger.error).not.toHaveBeenCalled();
  });
});
