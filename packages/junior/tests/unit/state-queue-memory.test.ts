import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("queue state helpers with memory adapter", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("supports queue ingress dedup without Redis", async () => {
    const { claimQueueIngressDedup, hasQueueIngressDedup } =
      await import("@/chat/state/queue-ingress-store");

    await expect(
      claimQueueIngressDedup("slack:C123:msg-1", 60_000),
    ).resolves.toBe(true);
    await expect(hasQueueIngressDedup("slack:C123:msg-1")).resolves.toBe(true);
    await expect(
      claimQueueIngressDedup("slack:C123:msg-1", 60_000),
    ).resolves.toBe(false);
  });

  it("supports queue message ownership lifecycle without Redis", async () => {
    const {
      acquireQueueMessageProcessingOwnership,
      completeQueueMessageProcessingOwnership,
      getQueueMessageProcessingState,
      refreshQueueMessageProcessingOwnership,
    } = await import("@/chat/state/queue-processing-store");

    await expect(
      acquireQueueMessageProcessingOwnership({
        rawKey: "slack:C123:msg-2",
        ownerToken: "owner-a",
        queueMessageId: "queue-1",
      }),
    ).resolves.toBe("acquired");

    await expect(
      getQueueMessageProcessingState("slack:C123:msg-2"),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "processing",
        ownerToken: "owner-a",
        queueMessageId: "queue-1",
      }),
    );

    await expect(
      refreshQueueMessageProcessingOwnership({
        rawKey: "slack:C123:msg-2",
        ownerToken: "owner-a",
        queueMessageId: "queue-1",
      }),
    ).resolves.toBe(true);

    await expect(
      completeQueueMessageProcessingOwnership({
        rawKey: "slack:C123:msg-2",
        ownerToken: "owner-a",
        queueMessageId: "queue-1",
      }),
    ).resolves.toBe(true);

    await expect(
      getQueueMessageProcessingState("slack:C123:msg-2"),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "completed",
        ownerToken: "owner-a",
        queueMessageId: "queue-1",
      }),
    );
  });

  it("supports failed-turn recovery without Redis", async () => {
    const {
      acquireQueueMessageProcessingOwnership,
      failQueueMessageProcessingOwnership,
      getQueueMessageProcessingState,
    } = await import("@/chat/state/queue-processing-store");

    await expect(
      acquireQueueMessageProcessingOwnership({
        rawKey: "slack:C123:msg-3",
        ownerToken: "owner-a",
        queueMessageId: "queue-2",
      }),
    ).resolves.toBe("acquired");

    await expect(
      failQueueMessageProcessingOwnership({
        rawKey: "slack:C123:msg-3",
        ownerToken: "owner-a",
        queueMessageId: "queue-2",
        errorMessage: "boom",
      }),
    ).resolves.toBe(true);

    await expect(
      getQueueMessageProcessingState("slack:C123:msg-3"),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        ownerToken: "owner-a",
        queueMessageId: "queue-2",
        errorMessage: "boom",
      }),
    );

    await expect(
      acquireQueueMessageProcessingOwnership({
        rawKey: "slack:C123:msg-3",
        ownerToken: "owner-b",
        queueMessageId: "queue-3",
      }),
    ).resolves.toBe("recovered");
  });
});
