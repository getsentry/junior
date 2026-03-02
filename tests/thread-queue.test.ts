import { describe, expect, it, vi, beforeEach } from "vitest";
import { LockError, Message } from "chat";

// Mock the state module before importing thread-queue
const mockRedisClient = {
  lLen: vi.fn(),
  rPush: vi.fn(),
  lPush: vi.fn(),
  lPop: vi.fn(),
  pExpire: vi.fn(),
};

const mockStateAdapter = {
  delete: vi.fn(),
};

vi.mock("@/chat/state", () => ({
  getRedisClient: () => mockRedisClient,
  getStateAdapter: () => mockStateAdapter,
}));

vi.mock("@/chat/observability", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { enqueueMessage, drainThreadQueue } from "@/chat/thread-queue";

function makeMessageData(overrides: Partial<ConstructorParameters<typeof Message>[0]> = {}) {
  return {
    id: "msg-1",
    threadId: "slack:C123:1700000000.100",
    text: "hello",
    formatted: { type: "root" as const, children: [] },
    raw: { channel: "C123", ts: "1700000000.200" },
    author: { fullName: "Test User", isBot: false, isMe: false, userId: "U123", userName: "testuser" },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [],
    ...overrides,
  };
}

describe("thread-queue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRedisClient.lLen.mockResolvedValue(0);
    mockRedisClient.rPush.mockResolvedValue(1);
    mockRedisClient.lPush.mockResolvedValue(1);
    mockRedisClient.lPop.mockResolvedValue(null);
    mockRedisClient.pExpire.mockResolvedValue(true);
    mockStateAdapter.delete.mockResolvedValue(undefined);
  });

  describe("enqueueMessage", () => {
    it("pushes serialized message to Redis LIST", async () => {
      const msg = new Message(makeMessageData());
      await enqueueMessage("slack:C123:ts1", "slack", msg);

      expect(mockRedisClient.rPush).toHaveBeenCalledOnce();
      const [key, value] = mockRedisClient.rPush.mock.calls[0];
      expect(key).toBe("chat-sdk:queue:thread:slack:C123:ts1");

      const parsed = JSON.parse(value);
      expect(parsed.adapterName).toBe("slack");
      expect(parsed.threadId).toBe("slack:C123:ts1");
      expect(parsed.messageId).toBe("msg-1");
      expect(parsed.messageData).toBeDefined();
      expect(parsed.enqueuedAt).toBeTypeOf("number");
    });

    it("sets TTL on the queue key", async () => {
      const msg = new Message(makeMessageData());
      await enqueueMessage("slack:C123:ts1", "slack", msg);

      expect(mockRedisClient.pExpire).toHaveBeenCalledWith(
        "chat-sdk:queue:thread:slack:C123:ts1",
        10 * 60 * 1000
      );
    });

    it("clears dedup key before enqueuing", async () => {
      const msg = new Message(makeMessageData({ id: "msg-42" }));
      await enqueueMessage("slack:C123:ts1", "slack", msg);

      expect(mockStateAdapter.delete).toHaveBeenCalledWith("dedupe:slack:msg-42");
    });

    it("drops message when queue is at max depth", async () => {
      mockRedisClient.lLen.mockResolvedValue(5);

      const msg = new Message(makeMessageData());
      await enqueueMessage("slack:C123:ts1", "slack", msg);

      expect(mockRedisClient.rPush).not.toHaveBeenCalled();
    });

    it("handles messages without an id", async () => {
      const msg = { text: "no id" };
      await enqueueMessage("slack:C123:ts1", "slack", msg);

      expect(mockStateAdapter.delete).not.toHaveBeenCalled();
      expect(mockRedisClient.rPush).toHaveBeenCalledOnce();
    });
  });

  describe("drainThreadQueue", () => {
    it("processes queued messages in order", async () => {
      const calls: string[] = [];
      const chat = {
        handleIncomingMessage: vi.fn(async (_adapter, _threadId, message) => {
          calls.push((message as Message).id);
        }),
      };

      const entry1 = JSON.stringify({
        enqueuedAt: Date.now(),
        adapterName: "slack",
        threadId: "slack:C123:ts1",
        messageId: "msg-1",
        messageData: makeMessageData({ id: "msg-1" }),
      });
      const entry2 = JSON.stringify({
        enqueuedAt: Date.now(),
        adapterName: "slack",
        threadId: "slack:C123:ts1",
        messageId: "msg-2",
        messageData: makeMessageData({ id: "msg-2" }),
      });

      mockRedisClient.lPop
        .mockResolvedValueOnce(entry1)
        .mockResolvedValueOnce(entry2)
        .mockResolvedValueOnce(null);

      await drainThreadQueue(chat, { name: "slack" }, "slack:C123:ts1");

      expect(calls).toEqual(["msg-1", "msg-2"]);
      expect(chat.handleIncomingMessage).toHaveBeenCalledTimes(2);
    });

    it("does nothing when queue is empty", async () => {
      const chat = { handleIncomingMessage: vi.fn() };
      mockRedisClient.lPop.mockResolvedValue(null);

      await drainThreadQueue(chat, { name: "slack" }, "slack:C123:ts1");

      expect(chat.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it("skips stale messages", async () => {
      const chat = { handleIncomingMessage: vi.fn() };

      const staleEntry = JSON.stringify({
        enqueuedAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago
        adapterName: "slack",
        threadId: "slack:C123:ts1",
        messageId: "msg-stale",
        messageData: makeMessageData({ id: "msg-stale" }),
      });

      mockRedisClient.lPop
        .mockResolvedValueOnce(staleEntry)
        .mockResolvedValueOnce(null);

      await drainThreadQueue(chat, { name: "slack" }, "slack:C123:ts1");

      expect(chat.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it("re-enqueues and stops on LockError during drain", async () => {
      const chat = {
        handleIncomingMessage: vi.fn().mockRejectedValue(new LockError("locked")),
      };

      const entry = JSON.stringify({
        enqueuedAt: Date.now(),
        adapterName: "slack",
        threadId: "slack:C123:ts1",
        messageId: "msg-1",
        messageData: makeMessageData({ id: "msg-1" }),
      });

      mockRedisClient.lPop
        .mockResolvedValueOnce(entry)
        .mockResolvedValueOnce(null);

      await drainThreadQueue(chat, { name: "slack" }, "slack:C123:ts1");

      // Should re-enqueue via LPUSH (front of list)
      expect(mockRedisClient.lPush).toHaveBeenCalledWith(
        "chat-sdk:queue:thread:slack:C123:ts1",
        entry
      );
      // Should stop after re-enqueue (only 1 handleIncomingMessage call)
      expect(chat.handleIncomingMessage).toHaveBeenCalledTimes(1);
    });

    it("continues draining on non-LockError failures", async () => {
      const calls: string[] = [];
      const chat = {
        handleIncomingMessage: vi.fn(async (_adapter, _threadId, message) => {
          const msg = message as Message;
          if (msg.id === "msg-1") throw new Error("boom");
          calls.push(msg.id);
        }),
      };

      const entry1 = JSON.stringify({
        enqueuedAt: Date.now(),
        adapterName: "slack",
        threadId: "slack:C123:ts1",
        messageId: "msg-1",
        messageData: makeMessageData({ id: "msg-1" }),
      });
      const entry2 = JSON.stringify({
        enqueuedAt: Date.now(),
        adapterName: "slack",
        threadId: "slack:C123:ts1",
        messageId: "msg-2",
        messageData: makeMessageData({ id: "msg-2" }),
      });

      mockRedisClient.lPop
        .mockResolvedValueOnce(entry1)
        .mockResolvedValueOnce(entry2)
        .mockResolvedValueOnce(null);

      await drainThreadQueue(chat, { name: "slack" }, "slack:C123:ts1");

      // msg-1 fails but msg-2 should still be processed
      expect(calls).toEqual(["msg-2"]);
    });

    it("clears dedup key before replaying each message", async () => {
      const chat = { handleIncomingMessage: vi.fn() };

      const entry = JSON.stringify({
        enqueuedAt: Date.now(),
        adapterName: "slack",
        threadId: "slack:C123:ts1",
        messageId: "msg-1",
        messageData: makeMessageData({ id: "msg-1" }),
      });

      mockRedisClient.lPop
        .mockResolvedValueOnce(entry)
        .mockResolvedValueOnce(null);

      await drainThreadQueue(chat, { name: "slack" }, "slack:C123:ts1");

      expect(mockStateAdapter.delete).toHaveBeenCalledWith("dedupe:slack:msg-1");
    });

    it("skips malformed entries", async () => {
      const chat = { handleIncomingMessage: vi.fn() };

      mockRedisClient.lPop
        .mockResolvedValueOnce("not-valid-json{{{")
        .mockResolvedValueOnce(null);

      await drainThreadQueue(chat, { name: "slack" }, "slack:C123:ts1");

      expect(chat.handleIncomingMessage).not.toHaveBeenCalled();
    });
  });
});
