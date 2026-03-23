import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/queue/types";

const {
  connectStateAdapterMock,
  acquireThreadLockMock,
  extendThreadLockMock,
  releaseThreadLockMock,
  getQueueMessageProcessingStateMock,
  acquireQueueMessageProcessingOwnershipMock,
  refreshQueueMessageProcessingOwnershipMock,
  completeQueueMessageProcessingOwnershipMock,
  failQueueMessageProcessingOwnershipMock,
} = vi.hoisted(() => ({
  connectStateAdapterMock: vi.fn(async () => undefined),
  acquireThreadLockMock: vi.fn<() => Promise<{ id: string } | null>>(
    async () => ({ id: "lock-1" }),
  ),
  extendThreadLockMock: vi.fn(async () => undefined),
  releaseThreadLockMock: vi.fn(async () => undefined),
  getQueueMessageProcessingStateMock: vi.fn(async () => undefined),
  acquireQueueMessageProcessingOwnershipMock: vi.fn(async () => "acquired"),
  refreshQueueMessageProcessingOwnershipMock: vi.fn(async () => true),
  completeQueueMessageProcessingOwnershipMock: vi.fn(async () => true),
  failQueueMessageProcessingOwnershipMock: vi.fn(async () => true),
}));

vi.mock("@/chat/state/adapter", () => ({
  getStateAdapter: () => ({
    connect: connectStateAdapterMock,
    acquireLock: acquireThreadLockMock,
    extendLock: extendThreadLockMock,
    releaseLock: releaseThreadLockMock,
  }),
}));

vi.mock("@/chat/state/queue-processing-store", () => ({
  getQueueMessageProcessingState: getQueueMessageProcessingStateMock,
  acquireQueueMessageProcessingOwnership:
    acquireQueueMessageProcessingOwnershipMock,
  refreshQueueMessageProcessingOwnership:
    refreshQueueMessageProcessingOwnershipMock,
  completeQueueMessageProcessingOwnership:
    completeQueueMessageProcessingOwnershipMock,
  failQueueMessageProcessingOwnership: failQueueMessageProcessingOwnershipMock,
}));

import { processQueuedThreadMessage } from "@/chat/queue/process-thread-message";

function createPayload(
  overrides: Partial<{
    messageId: string;
    threadState: Record<string, unknown>;
  }> = {},
): ThreadMessagePayload {
  const messageId = overrides.messageId ?? "1700000000.200";
  return {
    dedupKey: `slack:C123:1700000000.100:${messageId}`,
    kind: "new_mention",
    normalizedThreadId: "slack:C123:1700000000.100",
    queueMessageId: "msg_123",
    thread: {
      id: "slack:C123:1700000000.100",
      channelId: "C123",
      isDM: false,
      state: Promise.resolve(overrides.threadState ?? {}),
    } as unknown as ThreadMessagePayload["thread"],
    message: {
      id: messageId,
      author: {
        userId: "U_TEST",
        isMe: false,
      },
      attachments: [],
    } as unknown as ThreadMessagePayload["message"],
  };
}

describe("processQueuedThreadMessage reaction regressions", () => {
  beforeEach(() => {
    connectStateAdapterMock.mockReset();
    connectStateAdapterMock.mockResolvedValue(undefined);
    acquireThreadLockMock.mockReset();
    acquireThreadLockMock.mockResolvedValue({ id: "lock-1" });
    extendThreadLockMock.mockReset();
    extendThreadLockMock.mockResolvedValue(undefined);
    releaseThreadLockMock.mockReset();
    releaseThreadLockMock.mockResolvedValue(undefined);
    getQueueMessageProcessingStateMock.mockReset();
    getQueueMessageProcessingStateMock.mockResolvedValue(undefined);
    acquireQueueMessageProcessingOwnershipMock.mockReset();
    acquireQueueMessageProcessingOwnershipMock.mockResolvedValue("acquired");
    refreshQueueMessageProcessingOwnershipMock.mockReset();
    refreshQueueMessageProcessingOwnershipMock.mockResolvedValue(true);
    completeQueueMessageProcessingOwnershipMock.mockReset();
    completeQueueMessageProcessingOwnershipMock.mockResolvedValue(true);
    failQueueMessageProcessingOwnershipMock.mockReset();
    failQueueMessageProcessingOwnershipMock.mockResolvedValue(true);
  });

  it("removes ingress :eyes: after the runtime completes the turn", async () => {
    const steps: string[] = [];
    const clearProcessingReaction = vi.fn(async () => {
      steps.push("clear");
    });
    const dispatch = vi.fn(async () => {
      steps.push("runtime");
      steps.push("post");
    });
    const payload = createPayload();

    await processQueuedThreadMessage(payload, {
      clearProcessingReaction,
      dispatch,
      logInfo: vi.fn(),
      logWarn: vi.fn(),
    });

    expect(clearProcessingReaction).toHaveBeenCalledWith({
      channelId: "C123",
      timestamp: "1700000000.200",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(["runtime", "post", "clear"]);
  });

  it("continues queue turn when :eyes: removal fails after queue completion", async () => {
    const payload = createPayload();
    const dispatch = vi.fn(async () => undefined);
    const logWarn = vi.fn();

    await processQueuedThreadMessage(payload, {
      clearProcessingReaction: vi.fn(async () => {
        throw new Error("reaction remove failed");
      }),
      logInfo: vi.fn(),
      dispatch,
      logWarn,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "queue_processing_reaction_clear_failed",
      expect.objectContaining({
        slackThreadId: "slack:C123:1700000000.100",
        slackChannelId: "C123",
        slackUserId: "U_TEST",
      }),
      expect.objectContaining({
        "messaging.message.id": "1700000000.200",
        "error.message": "reaction remove failed",
      }),
      "Failed to remove processing reaction after queue turn completion",
    );
  });

  it("logs and returns when the queue message is already completed", async () => {
    const payload = createPayload();
    const logInfo = vi.fn();
    const dispatch = vi.fn();

    getQueueMessageProcessingStateMock.mockResolvedValueOnce({
      status: "completed",
      updatedAtMs: Date.now(),
    } as unknown as Awaited<
      ReturnType<typeof getQueueMessageProcessingStateMock>
    >);

    await processQueuedThreadMessage(payload, {
      clearProcessingReaction: vi.fn(),
      dispatch,
      logInfo,
      logWarn: vi.fn(),
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      "queue_message_skipped_completed",
      expect.objectContaining({
        slackThreadId: "slack:C123:1700000000.100",
        slackChannelId: "C123",
        slackUserId: "U_TEST",
      }),
      expect.objectContaining({
        "messaging.message.id": "1700000000.200",
        "app.queue.message_id": "msg_123",
        "app.queue.processing_state": "completed",
      }),
      "Skipping queue message because it is already completed",
    );
  });

  it("logs and returns when queue message ownership is blocked", async () => {
    const payload = createPayload();
    const logInfo = vi.fn();
    const dispatch = vi.fn();

    acquireQueueMessageProcessingOwnershipMock.mockResolvedValueOnce("blocked");

    await processQueuedThreadMessage(payload, {
      clearProcessingReaction: vi.fn(),
      dispatch,
      logInfo,
      logWarn: vi.fn(),
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      "queue_message_skipped_blocked",
      expect.objectContaining({
        slackThreadId: "slack:C123:1700000000.100",
        slackChannelId: "C123",
        slackUserId: "U_TEST",
      }),
      expect.objectContaining({
        "messaging.message.id": "1700000000.200",
        "app.queue.message_id": "msg_123",
        "app.queue.claim_result": "blocked",
        "app.queue.processing_state": "processing",
      }),
      "Skipping queue message because another worker owns it",
    );
  });

  it("defers queued messages while another worker owns the thread lock", async () => {
    const payload = createPayload();

    acquireThreadLockMock.mockResolvedValueOnce(null);

    await expect(
      processQueuedThreadMessage(payload, {
        clearProcessingReaction: vi.fn(),
        dispatch: vi.fn(),
        logInfo: vi.fn(),
        logWarn: vi.fn(),
      }),
    ).rejects.toThrow("already locked");

    expect(acquireQueueMessageProcessingOwnershipMock).not.toHaveBeenCalled();
    expect(releaseThreadLockMock).not.toHaveBeenCalled();
  });

  it("defers later queued messages while a different active turn is parked for resume", async () => {
    const payload = createPayload({
      messageId: "msg-next",
      threadState: {
        conversation: {
          processing: {
            activeTurnId: "turn_msg-current",
          },
        },
      },
    });

    await expect(
      processQueuedThreadMessage(payload, {
        clearProcessingReaction: vi.fn(),
        dispatch: vi.fn(),
        logInfo: vi.fn(),
        logWarn: vi.fn(),
      }),
    ).rejects.toThrow("activeTurnId=turn_msg-current");

    expect(acquireQueueMessageProcessingOwnershipMock).not.toHaveBeenCalled();
    expect(releaseThreadLockMock).toHaveBeenCalledTimes(1);
  });

  it("allows the same queued message to resume when it already owns the active turn", async () => {
    const payload = createPayload({
      messageId: "msg-retry",
      threadState: {
        conversation: {
          processing: {
            activeTurnId: "turn_msg-retry",
          },
        },
      },
    });
    const dispatch = vi.fn(async () => undefined);

    await processQueuedThreadMessage(payload, {
      clearProcessingReaction: vi.fn(async () => undefined),
      dispatch,
      logInfo: vi.fn(),
      logWarn: vi.fn(),
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(acquireQueueMessageProcessingOwnershipMock).toHaveBeenCalledTimes(1);
    expect(releaseThreadLockMock).toHaveBeenCalledTimes(1);
  });
});
