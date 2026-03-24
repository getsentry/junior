import { afterEach, describe, expect, it, vi } from "vitest";
import type { Adapter } from "chat";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import {
  TEST_DM_CHANNEL_ID,
  TEST_THREAD_TS,
  slackThreadId,
} from "../../fixtures/slack/factories/ids";

const {
  enqueueThreadMessageMock,
  hasQueueIngressDedupMock,
  claimQueueIngressDedupMock,
  isSubscribedMock,
  addReactionToMessageMock,
  removeReactionFromMessageMock,
} = vi.hoisted(() => ({
  enqueueThreadMessageMock: vi.fn(async () => "msg_abc123"),
  hasQueueIngressDedupMock: vi.fn(async () => false),
  claimQueueIngressDedupMock: vi.fn(async () => true),
  isSubscribedMock: vi.fn(async () => true),
  addReactionToMessageMock: vi.fn(async () => ({ ok: true })),
  removeReactionFromMessageMock: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/chat/queue/client", () => ({
  enqueueThreadMessage: enqueueThreadMessageMock,
}));

vi.mock("@/chat/state/adapter", () => ({
  getStateAdapter: () => ({
    isSubscribed: isSubscribedMock,
  }),
}));

vi.mock("@/chat/state/queue-ingress-store", () => ({
  hasQueueIngressDedup: hasQueueIngressDedupMock,
  claimQueueIngressDedup: claimQueueIngressDedupMock,
}));

vi.mock("@/chat/slack/channel", () => ({
  addReactionToMessage: addReactionToMessageMock,
  removeReactionFromMessage: removeReactionFromMessageMock,
}));

import { JuniorChat } from "@/chat/ingress/junior-chat";

describe("chat background queue enqueue", () => {
  afterEach(() => {
    enqueueThreadMessageMock.mockClear();
    hasQueueIngressDedupMock.mockClear();
    claimQueueIngressDedupMock.mockClear();
    isSubscribedMock.mockClear();
    addReactionToMessageMock.mockClear();
    removeReactionFromMessageMock.mockClear();
  });

  it("enqueues subscribed messages through default queue routing", async () => {
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const processMessage = JuniorChat.prototype
      .processMessage as unknown as Function;
    const adapter = {} as Adapter;

    const fakeChat = {
      logger: {
        error: vi.fn(),
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
          isDM: false,
        }),
      })),
      detectMention: vi.fn(() => false),
    };

    processMessage.call(
      fakeChat,
      adapter,
      "slack:C123:1700000000.100",
      {
        id: "1700000000.200",
        text: "hello",
        isMention: false,
        raw: {
          channel: "C123",
          thread_ts: "1700000000.100",
          ts: "1700000000.200",
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
          metadata: { dateSent: new Date().toISOString(), edited: false },
        }),
        attachments: [],
        author: {
          userId: "U_TEST",
          isMe: false,
        },
      },
      {
        waitUntil(task: Promise<unknown>) {
          waitUntilTasks.push(task);
        },
      },
    );

    expect(waitUntilTasks).toHaveLength(1);
    await expect(waitUntilTasks[0]).resolves.toBeUndefined();

    expect(isSubscribedMock).toHaveBeenCalledWith("slack:C123:1700000000.100");
    expect(hasQueueIngressDedupMock).toHaveBeenCalledWith(
      "slack:C123:1700000000.100:1700000000.200",
    );

    expect(enqueueThreadMessageMock).toHaveBeenCalledTimes(1);
    expect(addReactionToMessageMock).toHaveBeenCalledWith({
      channelId: "C123",
      timestamp: "1700000000.200",
      emoji: "eyes",
    });
    expect(removeReactionFromMessageMock).not.toHaveBeenCalled();
    expect(enqueueThreadMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "slack:C123:1700000000.100:1700000000.200",
        normalizedThreadId: "slack:C123:1700000000.100",
        kind: "subscribed_message",
      }),
      {
        idempotencyKey: "slack:C123:1700000000.100:1700000000.200",
      },
    );

    expect(claimQueueIngressDedupMock).toHaveBeenCalledWith(
      "slack:C123:1700000000.100:1700000000.200",
      24 * 60 * 60 * 1000,
    );
    expect(fakeChat.logger.error).not.toHaveBeenCalled();
  });

  it("enqueues non-mention DM messages through the new mention path", async () => {
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const processMessage = JuniorChat.prototype
      .processMessage as unknown as Function;
    const adapter = {} as Adapter;
    const threadId = slackThreadId(TEST_DM_CHANNEL_ID, TEST_THREAD_TS);
    const message = createTestMessage({
      id: "1700000000.201",
      threadId,
      text: "hello from a DM",
      isMention: false,
    });

    isSubscribedMock.mockResolvedValueOnce(false);

    const fakeChat = {
      logger: {
        error: vi.fn(),
      },
      createThread: vi.fn(async () =>
        createTestThread({
          id: threadId,
          channelId: TEST_DM_CHANNEL_ID,
        }),
      ),
      detectMention: vi.fn(() => false),
    };

    processMessage.call(fakeChat, adapter, threadId, message, {
      waitUntil(task: Promise<unknown>) {
        waitUntilTasks.push(task);
      },
    });

    expect(waitUntilTasks).toHaveLength(1);
    await expect(waitUntilTasks[0]).resolves.toBeUndefined();

    expect(isSubscribedMock).toHaveBeenCalledWith(threadId);
    expect(hasQueueIngressDedupMock).toHaveBeenCalledWith(
      `${threadId}:1700000000.201`,
    );
    expect(enqueueThreadMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: `${threadId}:1700000000.201`,
        normalizedThreadId: threadId,
        kind: "new_mention",
      }),
      {
        idempotencyKey: `${threadId}:1700000000.201`,
      },
    );
    expect(addReactionToMessageMock).toHaveBeenCalledWith({
      channelId: TEST_DM_CHANNEL_ID,
      timestamp: "1700000000.201",
      emoji: "eyes",
    });
    expect(fakeChat.logger.error).not.toHaveBeenCalled();
  });

  it("preserves fallback-detected mentions in subscribed thread payloads", async () => {
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const processMessage = JuniorChat.prototype
      .processMessage as unknown as Function;
    const adapter = {} as Adapter;
    const threadId = "slack:C123:1700000000.300";
    const message = {
      id: "1700000000.301",
      threadId,
      text: "<@U_APP> quick status?",
      isMention: false,
      raw: {
        channel: "C123",
        thread_ts: "1700000000.300",
        ts: "1700000000.301",
      },
      toJSON: () => ({
        _type: "chat:Message",
        id: message.id,
        threadId: message.threadId,
        text: message.text,
        formatted: { type: "root", children: [] },
        raw: message.text,
        author: { userId: "U_TEST", isMe: false },
        attachments: [],
        metadata: { dateSent: new Date().toISOString(), edited: false },
        isMention: message.isMention,
      }),
      attachments: [],
      author: {
        userId: "U_TEST",
        isMe: false,
      },
    };

    isSubscribedMock.mockResolvedValueOnce(true);

    const fakeChat = {
      logger: {
        error: vi.fn(),
      },
      createThread: vi.fn(async () => ({
        id: threadId,
        channelId: "C123",
        isDM: false,
        toJSON: () => ({
          _type: "chat:Thread",
          id: threadId,
          channelId: "C123",
          adapterName: "slack",
          isDM: false,
        }),
      })),
      detectMention: vi.fn(() => true),
    };

    processMessage.call(fakeChat, adapter, threadId, message, {
      waitUntil(task: Promise<unknown>) {
        waitUntilTasks.push(task);
      },
    });

    expect(waitUntilTasks).toHaveLength(1);
    await expect(waitUntilTasks[0]).resolves.toBeUndefined();

    expect(enqueueThreadMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "subscribed_message",
        message: expect.objectContaining({
          isMention: true,
        }),
      }),
      {
        idempotencyKey: `${threadId}:1700000000.301`,
      },
    );
    expect(fakeChat.logger.error).not.toHaveBeenCalled();
  });

  it("cleans up :eyes: when enqueue fails", async () => {
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const processMessage = JuniorChat.prototype
      .processMessage as unknown as Function;
    const adapter = {} as Adapter;

    enqueueThreadMessageMock.mockRejectedValueOnce(
      new Error("queue unavailable"),
    );

    const fakeChat = {
      logger: {
        error: vi.fn(),
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
          isDM: false,
        }),
      })),
      detectMention: vi.fn(() => true),
    };

    processMessage.call(
      fakeChat,
      adapter,
      "slack:C123:1700000000.100",
      {
        id: "1700000000.250",
        text: "hello",
        isMention: true,
        raw: {
          channel: "C123",
          thread_ts: "1700000000.100",
          ts: "1700000000.250",
        },
        attachments: [],
        author: {
          userId: "U_TEST",
          isMe: false,
        },
      },
      {
        waitUntil(task: Promise<unknown>) {
          waitUntilTasks.push(task);
        },
      },
    );

    expect(waitUntilTasks).toHaveLength(1);
    await expect(waitUntilTasks[0]).resolves.toBeUndefined();

    expect(addReactionToMessageMock).toHaveBeenCalledWith({
      channelId: "C123",
      timestamp: "1700000000.250",
      emoji: "eyes",
    });
    expect(removeReactionFromMessageMock).toHaveBeenCalledWith({
      channelId: "C123",
      timestamp: "1700000000.250",
      emoji: "eyes",
    });
    expect(claimQueueIngressDedupMock).not.toHaveBeenCalled();
    expect(fakeChat.logger.error).toHaveBeenCalled();
  });
});
