import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/queue/types";
import {
  QUEUE_INGRESS_DEDUP_TTL_MS,
  routeIncomingMessageToQueue,
} from "@/chat/ingress/message-router";

const {
  addReactionToMessageMock,
  claimQueueIngressDedupMock,
  getIsSubscribedMock,
  hasQueueIngressDedupMock,
  logInfoMock,
  logWarnMock,
  removeReactionFromMessageMock,
  setSpanAttributesMock,
  withContextMock,
  withSpanMock,
} = vi.hoisted(() => ({
  addReactionToMessageMock: vi.fn(async () => undefined),
  claimQueueIngressDedupMock: vi.fn(async () => true),
  getIsSubscribedMock: vi.fn(async () => false),
  hasQueueIngressDedupMock: vi.fn(async () => false),
  logInfoMock: vi.fn(),
  logWarnMock: vi.fn(),
  removeReactionFromMessageMock: vi.fn(async () => undefined),
  setSpanAttributesMock: vi.fn(),
  withContextMock: vi.fn(async (_context, run) => await run()),
  withSpanMock: vi.fn(async (_name, _op, _context, run) => await run()),
}));

vi.mock("@/chat/state/adapter", () => ({
  getStateAdapter: () => ({
    isSubscribed: getIsSubscribedMock,
  }),
}));

vi.mock("@/chat/state/queue-ingress-store", () => ({
  claimQueueIngressDedup: claimQueueIngressDedupMock,
  hasQueueIngressDedup: hasQueueIngressDedupMock,
}));

vi.mock("@/chat/slack/channel", () => ({
  addReactionToMessage: addReactionToMessageMock,
  removeReactionFromMessage: removeReactionFromMessageMock,
}));

vi.mock("@/chat/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/logging")>();
  return {
    ...actual,
    logInfo: logInfoMock,
    logWarn: logWarnMock,
    setSpanAttributes: setSpanAttributesMock,
    withContext: withContextMock,
    withSpan: withSpanMock,
  };
});

function createMessage(
  overrides: Partial<{
    id: string;
    isMention: boolean;
    isMe: boolean;
    raw: Record<string, unknown>;
  }> = {},
) {
  return {
    id: overrides.id ?? "1700000000.100",
    text: "hello",
    isMention: overrides.isMention ?? false,
    raw: overrides.raw ?? {
      channel: "C123",
      ts: "1700000000.100",
    },
    attachments: [],
    author: {
      userId: "U_TEST",
      isMe: overrides.isMe ?? false,
    },
  };
}

function createRuntime() {
  return {
    createThread: vi.fn(async () => ({ channelId: "slack:C123" })),
    detectMention: vi.fn(() => false),
  };
}

function createEnqueueThreadMessage(
  impl?: (
    payload: ThreadMessagePayload,
    dedupKey: string,
  ) => Promise<string | undefined>,
) {
  return vi.fn(
    impl ??
      (async (_payload: ThreadMessagePayload, _dedupKey: string) => undefined),
  );
}

describe("routeIncomingMessageToQueue", () => {
  beforeEach(() => {
    addReactionToMessageMock.mockReset();
    addReactionToMessageMock.mockResolvedValue(undefined);
    claimQueueIngressDedupMock.mockReset();
    claimQueueIngressDedupMock.mockResolvedValue(true);
    getIsSubscribedMock.mockReset();
    getIsSubscribedMock.mockResolvedValue(false);
    hasQueueIngressDedupMock.mockReset();
    hasQueueIngressDedupMock.mockResolvedValue(false);
    logInfoMock.mockReset();
    logWarnMock.mockReset();
    removeReactionFromMessageMock.mockReset();
    removeReactionFromMessageMock.mockResolvedValue(undefined);
    setSpanAttributesMock.mockReset();
    withContextMock.mockClear();
    withSpanMock.mockClear();
  });

  it("routes subscribed thread messages without preclassifying reply intent", async () => {
    const runtime = createRuntime();
    const enqueueThreadMessage = createEnqueueThreadMessage();
    getIsSubscribedMock.mockResolvedValue(true);
    const message = createMessage({ isMention: false });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      enqueueThreadMessage,
      message,
      runtime,
      threadId: "slack:C123:",
    });

    expect(result).toBe("routed");
    expect(addReactionToMessageMock).toHaveBeenCalledWith({
      channelId: "slack:C123",
      emoji: "eyes",
      timestamp: "1700000000.100",
    });
    expect(enqueueThreadMessage).toHaveBeenCalledTimes(1);
    const [payload] = enqueueThreadMessage.mock.calls[0] as [
      ThreadMessagePayload,
      string,
    ];
    expect(payload.kind).toBe("subscribed_message");
  });

  it("does not claim dedupe key for unsubscribed non-mention messages", async () => {
    const runtime = createRuntime();
    const enqueueThreadMessage = createEnqueueThreadMessage();
    const message = createMessage({ isMention: false });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      enqueueThreadMessage,
      message,
      runtime,
      threadId: "slack:C123:",
    });

    expect(result).toBe("ignored_unsubscribed_non_mention");
    expect(hasQueueIngressDedupMock).not.toHaveBeenCalled();
    expect(claimQueueIngressDedupMock).not.toHaveBeenCalled();
    expect(addReactionToMessageMock).not.toHaveBeenCalled();
    expect(enqueueThreadMessage).not.toHaveBeenCalled();
  });

  it("returns duplicate result when dedupe key already exists", async () => {
    const runtime = createRuntime();
    const enqueueThreadMessage = createEnqueueThreadMessage();
    hasQueueIngressDedupMock.mockResolvedValue(true);
    const message = createMessage({ isMention: true });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      enqueueThreadMessage,
      message,
      runtime,
      threadId: "slack:C123:",
    });

    expect(result).toBe("ignored_duplicate");
    expect(addReactionToMessageMock).not.toHaveBeenCalled();
    expect(enqueueThreadMessage).not.toHaveBeenCalled();
    expect(claimQueueIngressDedupMock).not.toHaveBeenCalled();
  });

  it("routes explicit mentions in unsubscribed threads without fallback detection", async () => {
    const runtime = createRuntime();
    const enqueueThreadMessage = createEnqueueThreadMessage(
      async () => "msg_123",
    );
    const message = createMessage({
      id: "1700000000.300",
      isMention: true,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      enqueueThreadMessage,
      message,
      runtime,
      threadId: "slack:C123:",
    });

    expect(result).toBe("routed");
    expect(runtime.detectMention).not.toHaveBeenCalled();
    expect(hasQueueIngressDedupMock).toHaveBeenCalledWith(
      "slack:C123:1700000000.100:1700000000.300",
    );
    expect(claimQueueIngressDedupMock).toHaveBeenCalledWith(
      "slack:C123:1700000000.100:1700000000.300",
      QUEUE_INGRESS_DEDUP_TTL_MS,
    );
    const [payload, dedupKey] = enqueueThreadMessage.mock.calls[0] as [
      ThreadMessagePayload,
      string,
    ];
    expect(dedupKey).toBe("slack:C123:1700000000.100:1700000000.300");
    expect(payload.kind).toBe("new_mention");
    expect(addReactionToMessageMock).toHaveBeenCalledWith({
      channelId: "slack:C123",
      emoji: "eyes",
      timestamp: "1700000000.300",
    });
  });

  it("routes fallback mention detection when SDK mention flag is false", async () => {
    const runtime = createRuntime();
    const enqueueThreadMessage = createEnqueueThreadMessage();
    runtime.detectMention = vi.fn(() => true);
    const message = createMessage({ isMention: false });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      enqueueThreadMessage,
      message,
      runtime,
      threadId: "slack:C123:",
    });

    expect(result).toBe("routed");
    expect(runtime.detectMention).toHaveBeenCalledTimes(1);
    const [payload] = enqueueThreadMessage.mock.calls[0] as [
      ThreadMessagePayload,
      string,
    ];
    expect(payload.kind).toBe("new_mention");
  });

  it("normalizes thread identity from raw slack fields before dedupe and routing", async () => {
    const runtime = createRuntime();
    const enqueueThreadMessage = createEnqueueThreadMessage();
    getIsSubscribedMock.mockResolvedValue(true);
    const message = createMessage({
      id: "1700000000.777",
      raw: {
        channel: "C777",
        thread_ts: "1700000000.555",
        ts: "1700000000.888",
      },
    }) as ReturnType<typeof createMessage> & { threadId?: string };
    message.threadId = "slack:WRONG:";

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      enqueueThreadMessage,
      message,
      runtime,
      threadId: "slack:WRONG:",
    });

    expect(result).toBe("routed");
    expect(getIsSubscribedMock).toHaveBeenCalledWith(
      "slack:C777:1700000000.555",
    );
    expect(hasQueueIngressDedupMock).toHaveBeenCalledWith(
      "slack:C777:1700000000.555:1700000000.777",
    );
    expect(claimQueueIngressDedupMock).toHaveBeenCalledWith(
      "slack:C777:1700000000.555:1700000000.777",
      QUEUE_INGRESS_DEDUP_TTL_MS,
    );
    const [payload] = enqueueThreadMessage.mock.calls[0] as [
      ThreadMessagePayload,
      string,
    ];
    expect(payload.normalizedThreadId).toBe("slack:C777:1700000000.555");
    expect(payload.dedupKey).toBe("slack:C777:1700000000.555:1700000000.777");
    expect(message.threadId).toBe("slack:C777:1700000000.555");
  });

  it("ignores self-authored messages before queue routing", async () => {
    const runtime = createRuntime();
    const enqueueThreadMessage = createEnqueueThreadMessage();
    const message = createMessage({
      isMe: true,
      isMention: true,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      enqueueThreadMessage,
      message,
      runtime,
      threadId: "slack:C123:",
    });

    expect(result).toBe("ignored_self_message");
    expect(hasQueueIngressDedupMock).not.toHaveBeenCalled();
    expect(claimQueueIngressDedupMock).not.toHaveBeenCalled();
    expect(addReactionToMessageMock).not.toHaveBeenCalled();
    expect(enqueueThreadMessage).not.toHaveBeenCalled();
  });

  it("ignores messages without an id", async () => {
    const runtime = createRuntime();
    const enqueueThreadMessage = createEnqueueThreadMessage();
    const message = {
      ...createMessage(),
      id: undefined,
    } as unknown as ReturnType<typeof createMessage> & { id?: string };

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      enqueueThreadMessage,
      message,
      runtime,
      threadId: "slack:C123:",
    });

    expect(result).toBe("ignored_missing_message_id");
  });

  it("does not mark dedupe when routing fails so retries are still allowed", async () => {
    const runtime = createRuntime();
    const enqueueThreadMessage = createEnqueueThreadMessage(async () => {
      throw new Error("queue unavailable");
    });
    getIsSubscribedMock.mockResolvedValue(true);
    const message = createMessage({
      id: "1700000000.901",
      isMention: true,
    });

    await expect(
      routeIncomingMessageToQueue({
        adapter: {},
        enqueueThreadMessage,
        message,
        runtime,
        threadId: "slack:C123:",
      }),
    ).rejects.toThrow("queue unavailable");

    expect(addReactionToMessageMock).toHaveBeenCalledWith({
      channelId: "slack:C123",
      emoji: "eyes",
      timestamp: "1700000000.901",
    });
    expect(removeReactionFromMessageMock).toHaveBeenCalledWith({
      channelId: "slack:C123",
      emoji: "eyes",
      timestamp: "1700000000.901",
    });
    expect(claimQueueIngressDedupMock).not.toHaveBeenCalled();
  });

  it("continues routing when ingress reaction add fails", async () => {
    const runtime = createRuntime();
    const enqueueThreadMessage = createEnqueueThreadMessage(
      async () => "msg_eyes",
    );
    getIsSubscribedMock.mockResolvedValue(true);
    addReactionToMessageMock.mockRejectedValue(
      new Error("reaction unavailable"),
    );
    const message = createMessage({
      id: "1700000000.950",
      isMention: true,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      enqueueThreadMessage,
      message,
      runtime,
      threadId: "slack:C123:",
    });

    expect(result).toBe("routed");
    expect(enqueueThreadMessage).toHaveBeenCalledTimes(1);
    expect(removeReactionFromMessageMock).not.toHaveBeenCalled();
  });

  it("still enqueues passive subscribed messages for runtime-owned routing", async () => {
    const runtime = createRuntime();
    const enqueueThreadMessage = createEnqueueThreadMessage();
    getIsSubscribedMock.mockResolvedValue(true);
    const message = createMessage({
      id: "1700000000.951",
      isMention: false,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      enqueueThreadMessage,
      message,
      runtime,
      threadId: "slack:C123:",
    });

    expect(result).toBe("routed");
    expect(enqueueThreadMessage).toHaveBeenCalledTimes(1);
    expect(addReactionToMessageMock).toHaveBeenCalledTimes(1);
    expect(claimQueueIngressDedupMock).toHaveBeenCalledTimes(1);
  });

  it("routes successfully on retry after an initial routing failure", async () => {
    const runtime = createRuntime();
    let dedupMarked = false;
    hasQueueIngressDedupMock.mockImplementation(async () => dedupMarked);
    claimQueueIngressDedupMock.mockImplementation(async () => {
      dedupMarked = true;
      return true;
    });
    getIsSubscribedMock.mockResolvedValue(true);
    const enqueueThreadMessage = vi
      .fn<
        (
          payload: ThreadMessagePayload,
          dedupKey: string,
        ) => Promise<string | undefined>
      >()
      .mockRejectedValueOnce(new Error("transient routing failure"))
      .mockResolvedValueOnce("msg_456");
    const message = createMessage({
      id: "1700000000.902",
      isMention: true,
    });

    await expect(
      routeIncomingMessageToQueue({
        adapter: {},
        enqueueThreadMessage,
        message,
        runtime,
        threadId: "slack:C123:",
      }),
    ).rejects.toThrow("transient routing failure");

    const secondResult = await routeIncomingMessageToQueue({
      adapter: {},
      enqueueThreadMessage,
      message,
      runtime,
      threadId: "slack:C123:",
    });

    expect(secondResult).toBe("routed");
    expect(enqueueThreadMessage).toHaveBeenCalledTimes(2);
    expect(claimQueueIngressDedupMock).toHaveBeenCalledTimes(1);
  });
});
