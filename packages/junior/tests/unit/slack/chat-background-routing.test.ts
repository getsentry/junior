import { describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/queue/types";
import {
  QUEUE_INGRESS_DEDUP_TTL_MS,
  routeIncomingMessageToQueue,
} from "@/chat/chat-background-patch";

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

function createDeps(
  overrides: Partial<{
    hasDedup: (key: string) => Promise<boolean>;
    markDedup: (key: string, ttlMs: number) => Promise<boolean>;
    getIsSubscribed: (threadId: string) => Promise<boolean>;
    logInfo: (...args: unknown[]) => void;
    logWarn: (...args: unknown[]) => void;
    enqueueThreadMessage: (
      payload: ThreadMessagePayload,
      dedupKey: string,
    ) => Promise<string | undefined>;
    shouldReplyInSubscribedThread: (
      args: unknown,
    ) => Promise<{ shouldReply: boolean; reason: string }>;
    addProcessingReaction: (input: {
      channelId: string;
      timestamp: string;
    }) => Promise<void>;
    removeProcessingReaction: (input: {
      channelId: string;
      timestamp: string;
    }) => Promise<void>;
  }> = {},
) {
  return {
    hasDedup: overrides.hasDedup ?? vi.fn(async () => false),
    markDedup: overrides.markDedup ?? vi.fn(async () => true),
    getIsSubscribed: overrides.getIsSubscribed ?? vi.fn(async () => false),
    logInfo: overrides.logInfo ?? vi.fn(),
    logWarn: overrides.logWarn ?? vi.fn(),
    enqueueThreadMessage:
      overrides.enqueueThreadMessage ?? vi.fn(async () => undefined),
    shouldReplyInSubscribedThread:
      overrides.shouldReplyInSubscribedThread ??
      vi.fn(async () => ({
        shouldReply: true,
        reason: "explicit_ask",
      })),
    addProcessingReaction:
      overrides.addProcessingReaction ?? vi.fn(async () => undefined),
    removeProcessingReaction:
      overrides.removeProcessingReaction ?? vi.fn(async () => undefined),
  };
}

describe("routeIncomingMessageToQueue", () => {
  it("routes subscribed thread messages", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => true),
    });
    const message = createMessage({
      isMention: false,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps,
    });

    expect(result).toBe("routed");
    expect(deps.addProcessingReaction).toHaveBeenCalledWith({
      channelId: "slack:C123",
      timestamp: "1700000000.100",
    });
    expect(deps.enqueueThreadMessage).toHaveBeenCalledTimes(1);
    const [payload] = (deps.enqueueThreadMessage as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [ThreadMessagePayload, string];
    expect(payload.kind).toBe("subscribed_reply");
  });

  it("does not claim dedupe key for unsubscribed non-mention messages", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => false),
    });
    const message = createMessage({
      isMention: false,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps,
    });

    expect(result).toBe("ignored_unsubscribed_non_mention");
    expect(deps.hasDedup).not.toHaveBeenCalled();
    expect(deps.markDedup).not.toHaveBeenCalled();
    expect(deps.addProcessingReaction).not.toHaveBeenCalled();
    expect(deps.enqueueThreadMessage).not.toHaveBeenCalled();
    expect(deps.logInfo).toHaveBeenCalledWith(
      "queue_ingress_ignored_unsubscribed_non_mention",
      expect.objectContaining({
        slackThreadId: "slack:C123:1700000000.100",
        slackChannelId: "C123",
        slackUserId: "U_TEST",
      }),
      expect.objectContaining({
        "messaging.message.id": "1700000000.100",
        "app.queue.route_result": "ignored_unsubscribed_non_mention",
      }),
      "Ignoring unsubscribed non-mention message before queue routing",
    );
  });

  it("returns duplicate result when dedupe key already exists", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => false),
      hasDedup: vi.fn(async () => true),
    });
    const message = createMessage({
      isMention: true,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps,
    });

    expect(result).toBe("ignored_duplicate");
    expect(deps.addProcessingReaction).not.toHaveBeenCalled();
    expect(deps.enqueueThreadMessage).not.toHaveBeenCalled();
    expect(deps.markDedup).not.toHaveBeenCalled();
    expect(deps.logInfo).toHaveBeenCalledWith(
      "queue_ingress_dedup_hit",
      expect.any(Object),
      expect.objectContaining({
        "app.queue.dedup_outcome": "duplicate",
        "app.slack.mention_source": "sdk_flag",
        "app.queue.route_result": "ignored_duplicate",
      }),
      "Skipping duplicate incoming message before queue enqueue",
    );
  });

  it("routes explicit mentions in unsubscribed threads without fallback detection", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => false),
      enqueueThreadMessage: vi.fn(async () => "msg_123"),
    });
    const message = createMessage({
      id: "1700000000.300",
      isMention: true,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps,
    });

    expect(result).toBe("routed");
    expect(runtime.detectMention).not.toHaveBeenCalled();
    expect(deps.hasDedup).toHaveBeenCalledWith(
      "slack:C123:1700000000.100:1700000000.300",
    );
    expect(deps.markDedup).toHaveBeenCalledWith(
      "slack:C123:1700000000.100:1700000000.300",
      QUEUE_INGRESS_DEDUP_TTL_MS,
    );
    const [payload, dedupKey] = (
      deps.enqueueThreadMessage as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [ThreadMessagePayload, string];
    expect(dedupKey).toBe("slack:C123:1700000000.100:1700000000.300");
    expect(payload.kind).toBe("new_mention");
    expect(deps.addProcessingReaction).toHaveBeenCalledWith({
      channelId: "slack:C123",
      timestamp: "1700000000.300",
    });
    expect(deps.logInfo).toHaveBeenCalledWith(
      "queue_ingress_enqueued",
      {},
      expect.objectContaining({
        "app.queue.dedup_outcome": "primary",
        "app.slack.mention_source": "sdk_flag",
        "app.queue.message_id": "msg_123",
      }),
      "Routing incoming message to queue",
    );
  });

  it("routes fallback mention detection when SDK mention flag is false", async () => {
    const runtime = createRuntime();
    runtime.detectMention = vi.fn(() => true);
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => false),
    });
    const message = createMessage({
      isMention: false,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps,
    });

    expect(result).toBe("routed");
    expect(runtime.detectMention).toHaveBeenCalledTimes(1);
    const [payload] = (deps.enqueueThreadMessage as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [ThreadMessagePayload, string];
    expect(payload.kind).toBe("new_mention");
    expect(deps.logInfo).toHaveBeenCalledWith(
      "queue_ingress_enqueued",
      {},
      expect.objectContaining({
        "app.slack.mention_source": "fallback_detector",
      }),
      "Routing incoming message to queue",
    );
  });

  it("normalizes thread identity from raw slack fields before dedupe and routing", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => true),
    });
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
      threadId: "slack:WRONG:",
      message,
      runtime,
      deps,
    });

    expect(result).toBe("routed");
    expect(deps.getIsSubscribed).toHaveBeenCalledWith(
      "slack:C777:1700000000.555",
    );
    expect(deps.hasDedup).toHaveBeenCalledWith(
      "slack:C777:1700000000.555:1700000000.777",
    );
    expect(deps.markDedup).toHaveBeenCalledWith(
      "slack:C777:1700000000.555:1700000000.777",
      QUEUE_INGRESS_DEDUP_TTL_MS,
    );
    const [payload] = (deps.enqueueThreadMessage as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [ThreadMessagePayload, string];
    expect(payload.normalizedThreadId).toBe("slack:C777:1700000000.555");
    expect(payload.dedupKey).toBe("slack:C777:1700000000.555:1700000000.777");
    expect(message.threadId).toBe("slack:C777:1700000000.555");
  });

  it("ignores self-authored messages before queue routing", async () => {
    const runtime = createRuntime();
    const deps = createDeps();
    const message = createMessage({
      isMe: true,
      isMention: true,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps,
    });

    expect(result).toBe("ignored_self_message");
    expect(deps.hasDedup).not.toHaveBeenCalled();
    expect(deps.markDedup).not.toHaveBeenCalled();
    expect(deps.addProcessingReaction).not.toHaveBeenCalled();
    expect(deps.logInfo).toHaveBeenCalledWith(
      "queue_ingress_ignored_self_message",
      expect.objectContaining({
        slackThreadId: "slack:C123:1700000000.100",
        slackChannelId: "C123",
        slackUserId: "U_TEST",
      }),
      expect.objectContaining({
        "messaging.message.id": "1700000000.100",
        "app.queue.route_result": "ignored_self_message",
      }),
      "Ignoring self-authored message before queue routing",
    );
    expect(deps.enqueueThreadMessage).not.toHaveBeenCalled();
  });

  it("logs and ignores messages without an id", async () => {
    const runtime = createRuntime();
    const deps = createDeps();
    const message = {
      ...createMessage(),
      id: undefined,
    } as unknown as ReturnType<typeof createMessage> & { id?: string };

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps,
    });

    expect(result).toBe("ignored_missing_message_id");
    expect(deps.logInfo).toHaveBeenCalledWith(
      "queue_ingress_ignored_missing_message_id",
      expect.objectContaining({
        slackThreadId: "slack:C123:1700000000.100",
        slackChannelId: "C123",
        slackUserId: "U_TEST",
      }),
      expect.objectContaining({
        "app.queue.route_result": "ignored_missing_message_id",
      }),
      "Ignoring message without an id before queue routing",
    );
  });

  it("does not mark dedupe when routing fails so retries are still allowed", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => true),
      enqueueThreadMessage: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
    });
    const message = createMessage({
      id: "1700000000.901",
      isMention: true,
    });

    await expect(
      routeIncomingMessageToQueue({
        adapter: {},
        threadId: "slack:C123:",
        message,
        runtime,
        deps,
      }),
    ).rejects.toThrow("queue unavailable");

    expect(deps.addProcessingReaction).toHaveBeenCalledWith({
      channelId: "slack:C123",
      timestamp: "1700000000.901",
    });
    expect(deps.removeProcessingReaction).toHaveBeenCalledWith({
      channelId: "slack:C123",
      timestamp: "1700000000.901",
    });
    expect(deps.markDedup).not.toHaveBeenCalled();
  });

  it("continues routing when ingress reaction add fails", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => true),
      addProcessingReaction: vi.fn(async () => {
        throw new Error("reaction unavailable");
      }),
      enqueueThreadMessage: vi.fn(async () => "msg_eyes"),
    });
    const message = createMessage({
      id: "1700000000.950",
      isMention: true,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps,
    });

    expect(result).toBe("routed");
    expect(deps.enqueueThreadMessage).toHaveBeenCalledTimes(1);
    expect(deps.removeProcessingReaction).not.toHaveBeenCalled();
    expect(deps.logWarn).toHaveBeenCalledWith(
      "queue_ingress_reaction_add_failed",
      {},
      expect.objectContaining({
        "messaging.message.id": "1700000000.950",
        "app.queue.message_kind": "subscribed_message",
        "error.message": "reaction unavailable",
      }),
      "Failed to add ingress processing reaction",
    );
  });

  it("skips enqueue and reaction when webhook passive routing decides no reply", async () => {
    const runtime = createRuntime();
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => true),
      shouldReplyInSubscribedThread: vi.fn(async () => ({
        shouldReply: false,
        reason: "side_conversation",
      })),
    });
    const message = createMessage({
      id: "1700000000.951",
      isMention: false,
    });

    const result = await routeIncomingMessageToQueue({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps,
    });

    expect(result).toBe("ignored_passive_no_reply");
    expect(deps.enqueueThreadMessage).not.toHaveBeenCalled();
    expect(deps.addProcessingReaction).not.toHaveBeenCalled();
    expect(deps.markDedup).not.toHaveBeenCalled();
    expect(deps.logInfo).toHaveBeenCalledWith(
      "queue_ingress_ignored_passive_no_reply",
      expect.objectContaining({
        slackThreadId: "slack:C123:1700000000.100",
        slackChannelId: "C123",
        slackUserId: "U_TEST",
      }),
      expect.objectContaining({
        "messaging.message.id": "1700000000.951",
        "app.queue.message_kind": "subscribed_message",
        "app.queue.route_result": "ignored_passive_no_reply",
        "app.decision.reason": "side_conversation",
      }),
      "Skipping passive subscribed-thread reply before queue enqueue",
    );
  });

  it("routes successfully on retry after an initial routing failure", async () => {
    const runtime = createRuntime();
    let dedupMarked = false;
    const deps = createDeps({
      getIsSubscribed: vi.fn(async () => true),
      hasDedup: vi.fn(async () => dedupMarked),
      markDedup: vi.fn(async () => {
        dedupMarked = true;
        return true;
      }),
      enqueueThreadMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("transient routing failure"))
        .mockResolvedValueOnce("msg_456"),
    });
    const message = createMessage({
      id: "1700000000.902",
      isMention: true,
    });

    await expect(
      routeIncomingMessageToQueue({
        adapter: {},
        threadId: "slack:C123:",
        message,
        runtime,
        deps,
      }),
    ).rejects.toThrow("transient routing failure");

    const secondResult = await routeIncomingMessageToQueue({
      adapter: {},
      threadId: "slack:C123:",
      message,
      runtime,
      deps,
    });

    expect(secondResult).toBe("routed");
    expect(deps.enqueueThreadMessage).toHaveBeenCalledTimes(2);
    expect(deps.markDedup).toHaveBeenCalledTimes(1);
  });
});
