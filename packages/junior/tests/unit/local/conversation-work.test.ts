import { describe, expect, it, vi } from "vitest";
import { createLocalConversationWork } from "@/chat/local/conversation-work";

describe("local conversation work", () => {
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
        await localWork.queue.send({ conversationId: "follow-up" });
      }
    });

    await localWork.queue.send({ conversationId: "first" });
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
      localWork.queue.send({ conversationId: "failed" }),
    ).resolves.toBeUndefined();
    await expect(localWork.drain()).rejects.toThrow("local worker failed");
  });
});
