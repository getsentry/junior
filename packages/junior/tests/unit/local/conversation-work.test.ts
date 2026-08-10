import { describe, expect, it, vi } from "vitest";
import { createLocalConversationWork } from "@/chat/local/conversation-work";

describe("local conversation work", () => {
  it("does not consume a wake before the producer finishes enqueueing it", async () => {
    let processed = false;
    const localWork = createLocalConversationWork(async () => {
      processed = true;
    });

    await localWork.queue.send({
      schemaVersion: 2,
      conversationId: "deferred-start",
    });

    expect(processed).toBe(false);
    await localWork.drain();
    expect(processed).toBe(true);
  });

  it("deduplicates accepted wakes by idempotency key", async () => {
    const processed: string[] = [];
    const localWork = createLocalConversationWork(async (message) => {
      processed.push(message.conversationId);
    });

    const [first, replay] = await Promise.all([
      localWork.queue.send(
        { schemaVersion: 2, conversationId: "replayed" },
        { idempotencyKey: "same-wake" },
      ),
      localWork.queue.send(
        { schemaVersion: 2, conversationId: "replayed" },
        { idempotencyKey: "same-wake" },
      ),
    ]);
    await localWork.drain();

    expect(replay).toEqual(first);
    expect(processed).toEqual(["replayed"]);
  });

  it("runs independent conversation wakes concurrently", async () => {
    const started = new Set<string>();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const localWork = createLocalConversationWork(async (message) => {
      started.add(message.conversationId);
      await blocked;
    });

    await Promise.all([
      localWork.queue.send({ schemaVersion: 2, conversationId: "first" }),
      localWork.queue.send({ schemaVersion: 2, conversationId: "second" }),
    ]);
    const draining = localWork.drain();
    await vi.waitFor(() => {
      expect(started).toEqual(new Set(["first", "second"]));
    });
    release?.();
    await draining;
  });

  it("drains accepted work and follow-up wakes", async () => {
    const processed: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let localWork: ReturnType<typeof createLocalConversationWork>;
    localWork = createLocalConversationWork(async (message) => {
      processed.push(message.conversationId);
      if (message.conversationId === "first") {
        await firstBlocked;
        await localWork.queue.send({
          schemaVersion: 2,
          conversationId: "follow-up",
        });
      }
    });

    await localWork.queue.send({ schemaVersion: 2, conversationId: "first" });
    const draining = localWork.drain();
    await vi.waitFor(() => {
      expect(processed).toEqual(["first"]);
    });
    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseFirst?.();
    await draining;

    expect(processed).toEqual(["first", "follow-up"]);
  });

  it("reports processing failures when drained", async () => {
    const localWork = createLocalConversationWork(async () => {
      throw new Error("local worker failed");
    });

    await expect(
      localWork.queue.send({ schemaVersion: 2, conversationId: "failed" }),
    ).resolves.toEqual({
      messageId: "local-conversation-work:1",
    });
    await expect(localWork.drain()).rejects.toThrow("local worker failed");
  });
});
