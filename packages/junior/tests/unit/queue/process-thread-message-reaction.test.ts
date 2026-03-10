import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessagePayload } from "@/chat/queue/types";

const {
  getQueueMessageProcessingStateMock,
  acquireQueueMessageProcessingOwnershipMock,
  refreshQueueMessageProcessingOwnershipMock,
  completeQueueMessageProcessingOwnershipMock,
  failQueueMessageProcessingOwnershipMock
} = vi.hoisted(() => ({
  getQueueMessageProcessingStateMock: vi.fn(async () => undefined),
  acquireQueueMessageProcessingOwnershipMock: vi.fn(async () => "acquired"),
  refreshQueueMessageProcessingOwnershipMock: vi.fn(async () => true),
  completeQueueMessageProcessingOwnershipMock: vi.fn(async () => true),
  failQueueMessageProcessingOwnershipMock: vi.fn(async () => true)
}));

vi.mock("@/chat/state", () => ({
  getStateAdapter: () => ({
    connect: vi.fn(async () => undefined)
  }),
  getQueueMessageProcessingState: getQueueMessageProcessingStateMock,
  acquireQueueMessageProcessingOwnership: acquireQueueMessageProcessingOwnershipMock,
  refreshQueueMessageProcessingOwnership: refreshQueueMessageProcessingOwnershipMock,
  completeQueueMessageProcessingOwnership: completeQueueMessageProcessingOwnershipMock,
  failQueueMessageProcessingOwnership: failQueueMessageProcessingOwnershipMock
}));

import { processQueuedThreadMessage } from "@/chat/queue/process-thread-message";

function createPayload(): ThreadMessagePayload {
  return {
    dedupKey: "slack:C123:1700000000.100:1700000000.200",
    kind: "new_mention",
    normalizedThreadId: "slack:C123:1700000000.100",
    queueMessageId: "msg_123",
    thread: {
      id: "slack:C123:1700000000.100",
      channelId: "C123",
      isDM: false
    } as unknown as ThreadMessagePayload["thread"],
    message: {
      id: "1700000000.200",
      author: {
        userId: "U_TEST",
        isMe: false
      },
      attachments: []
    } as unknown as ThreadMessagePayload["message"]
  };
}

describe("processQueuedThreadMessage reaction regressions", () => {
  beforeEach(() => {
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
    const processRuntime = vi.fn(async () => {
      steps.push("runtime");
      steps.push("post");
    });
    const payload = createPayload();

    await processQueuedThreadMessage(payload, {
      clearProcessingReaction,
      processRuntime,
      logWarn: vi.fn()
    });

    expect(clearProcessingReaction).toHaveBeenCalledWith({
      channelId: "C123",
      timestamp: "1700000000.200"
    });
    expect(processRuntime).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(["runtime", "post", "clear"]);
  });

  it("continues queue turn when :eyes: removal fails after queue completion", async () => {
    const payload = createPayload();
    const processRuntime = vi.fn(async () => undefined);
    const logWarn = vi.fn();

    await processQueuedThreadMessage(payload, {
      clearProcessingReaction: vi.fn(async () => {
        throw new Error("reaction remove failed");
      }),
      processRuntime,
      logWarn
    });

    expect(processRuntime).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "queue_processing_reaction_clear_failed",
      expect.objectContaining({
        slackThreadId: "slack:C123:1700000000.100",
        slackChannelId: "C123",
        slackUserId: "U_TEST"
      }),
      expect.objectContaining({
        "messaging.message.id": "1700000000.200",
        "error.message": "reaction remove failed"
      }),
      "Failed to remove processing reaction after queue turn completion"
    );
  });
});
