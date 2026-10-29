import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getQueueProvider,
  type QueueConsumer,
  type QueueMessageMetadata,
  type QueueWorker,
} from "@/chat/queue/provider";

// Chat config reads the queue provider when it loads, so set it first. CI
// runs Redis at REDIS_URL. Locally, compose.yaml runs it on port 6382.
vi.hoisted(() => {
  process.env.JUNIOR_QUEUE_PROVIDER = "bullmq";
  process.env.JUNIOR_QUEUE_REDIS_URL =
    process.env.REDIS_URL?.trim() || "redis://localhost:6382";
});

let worker: QueueWorker | undefined;

afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

function uniqueTopic(name: string): string {
  return `junior_test_${name}_${randomUUID()}`;
}

async function startConsumer(
  topic: string,
  handler: QueueConsumer["handler"],
  retry: QueueConsumer["retry"] = () => undefined,
): Promise<QueueWorker> {
  const provider = getQueueProvider();
  if (!provider.startWorker) {
    throw new Error("The BullMQ provider must start workers");
  }
  worker = await provider.startWorker([
    { consumerGroup: `${topic}_dev`, handler, retry, topic },
  ]);
  return worker;
}

async function waitFor(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for queue delivery");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("BullMQ queue provider", () => {
  it("delivers each idempotency key once, in this process", async () => {
    const topic = uniqueTopic("delivery");
    const deliveries: Array<{
      metadata: QueueMessageMetadata;
      payload: unknown;
    }> = [];
    await startConsumer(topic, async (payload, metadata) => {
      deliveries.push({ metadata, payload });
    });

    const provider = getQueueProvider();
    expect(provider.messagingSystem).toBe("bullmq");
    // Junior's keys contain ":", which BullMQ does not allow in job ids.
    const key = `message:conversation_1:${Date.now()}`;
    const first = await provider.send(topic, { n: 1 }, { idempotencyKey: key });
    const second = await provider.send(
      topic,
      { n: 2 },
      { idempotencyKey: key },
    );
    await waitFor(() => deliveries.length > 0);
    await provider.send(topic, { n: 3 }, { idempotencyKey: key });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(second.messageId).toBe(first.messageId);
    expect(deliveries).toEqual([
      {
        metadata: expect.objectContaining({
          consumerGroup: `${topic}_dev`,
          deliveryCount: 1,
          messageId: first.messageId,
          topicName: topic,
        }),
        payload: { n: 1 },
      },
    ]);
  });

  it("retries a failed message until retry() acknowledges it", async () => {
    const topic = uniqueTopic("retry");
    const deliveryCounts: number[] = [];
    let acknowledged = false;
    await startConsumer(
      topic,
      async (_payload, metadata) => {
        deliveryCounts.push(metadata.deliveryCount);
        throw new Error("temporary failure");
      },
      (_error, metadata) => {
        if (metadata.deliveryCount < 3) {
          return undefined;
        }
        acknowledged = true;
        return { acknowledge: true };
      },
    );

    await getQueueProvider().send(topic, {});
    await waitFor(() => acknowledged, 15_000);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(deliveryCounts).toEqual([1, 2, 3]);
  }, 20_000);

  it("runs slow messages at the same time", async () => {
    const topic = uniqueTopic("concurrency");
    let running = 0;
    let mostRunning = 0;
    let finished = 0;
    await startConsumer(topic, async () => {
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 500));
      running -= 1;
      finished += 1;
    });

    await Promise.all(
      [1, 2, 3].map((n) => getQueueProvider().send(topic, { n })),
    );
    await waitFor(() => finished === 3);

    expect(mostRunning).toBe(3);
  });

  it("lets a running message finish before close() returns", async () => {
    const topic = uniqueTopic("close");
    let started = false;
    let finished = false;
    const running = await startConsumer(topic, async () => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
      finished = true;
    });

    await getQueueProvider().send(topic, {});
    await waitFor(() => started);
    await running.close();
    worker = undefined;

    expect(finished).toBe(true);
  });
});
