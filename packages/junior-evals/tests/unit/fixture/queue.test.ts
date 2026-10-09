import { describe, expect, it } from "vitest";
import { createInProcessQueue } from "@junior-evals/fixture/queue";

const message = (conversationId: string) => ({
  schemaVersion: 2 as const,
  conversationId,
});

async function drain(queue: ReturnType<typeof createInProcessQueue>) {
  while (queue.pending().length > 0) {
    await Promise.all(queue.pending());
  }
}

describe("createInProcessQueue", () => {
  it("calls the requeue hook for a message that the worker sent during a delivery", async () => {
    const queue = createInProcessQueue();
    const order: string[] = [];
    let deliveries = 0;
    queue.connect(async () => {
      deliveries += 1;
      order.push(`delivery ${deliveries}`);
      if (deliveries === 1) await queue.send(message("c1"));
    });
    queue.setRequeueHook(async (conversationId) => {
      order.push(`requeued ${conversationId}`);
    });

    await queue.send(message("c1"));
    await drain(queue);

    expect(order).toEqual(["delivery 1", "requeued c1", "delivery 2"]);
  });

  it("does not call the requeue hook for an input that a test posts during a delivery", async () => {
    const queue = createInProcessQueue();
    const requeued: string[] = [];
    let deliveries = 0;
    queue.connect(async () => {
      deliveries += 1;
      if (deliveries === 1) {
        // A progress handler posts the input while the turn runs.
        await queue.asInput(() => queue.send(message("c1")));
      }
    });
    queue.setRequeueHook(async (conversationId) => {
      requeued.push(conversationId);
    });

    await queue.send(message("c1"));
    await drain(queue);

    expect(deliveries).toBe(2);
    expect(requeued).toEqual([]);
  });
});
