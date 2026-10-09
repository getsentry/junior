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

  it("starts a delayed delivery early only when no delivery runs", async () => {
    const queue = createInProcessQueue();
    let finishFirst = () => {};
    const delivered: string[] = [];
    queue.connect(async (message) => {
      delivered.push(message.conversationId);
      if (message.conversationId === "c1") {
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
    });

    await queue.send(message("c1"));
    await queue.send(message("c2"), { delayMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.startDelayedDelivery()).toBe(false);

    finishFirst();
    while (queue.pending().length > 1) await Promise.race(queue.pending());
    expect(queue.startDelayedDelivery()).toBe(true);
    await drain(queue);

    expect(delivered).toEqual(["c1", "c2"]);
  });

  it("waits for the delay of a message that an early delivery sent", async () => {
    const queue = createInProcessQueue();
    let deliveries = 0;
    queue.connect(async () => {
      deliveries += 1;
      // The product asks for more time.
      if (deliveries === 1) await queue.send(message("c1"), { delayMs: 50 });
    });

    await queue.send(message("c1"), { delayMs: 60_000 });
    expect(queue.startDelayedDelivery()).toBe(true);
    while (deliveries === 0 || queue.pending().length > 1) {
      await Promise.race(queue.pending());
    }
    expect(queue.startDelayedDelivery()).toBe(false);
    await drain(queue);

    expect(deliveries).toBe(2);
  });
});
