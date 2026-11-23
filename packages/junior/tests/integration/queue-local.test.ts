import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startLocalQueueDelivery,
  type LocalQueueDelivery,
} from "@/chat/queue/local-delivery";
import {
  getQueueProvider,
  type QueueConsumer,
  type QueueMessageMetadata,
} from "@/chat/queue/provider";

// Chat config reads the queue provider when it loads, so set it first. The
// local queue keeps its jobs in the test database at DATABASE_URL.
vi.hoisted(() => {
  process.env["JUNIOR_QUEUE_PROVIDER"] = "local";
});

let delivery: LocalQueueDelivery | undefined;

afterEach(async () => {
  await delivery?.close();
  delivery = undefined;
});

function uniqueTopic(name: string): string {
  return `junior_test_${name}_${randomUUID()}`;
}

// Push messages to the consumer's callback the way the app routes them.
async function startConsumer(
  topic: string,
  handler: QueueConsumer["handler"],
  retry: QueueConsumer["retry"] = () => undefined,
): Promise<LocalQueueDelivery> {
  const consumer: QueueConsumer = {
    consumerGroup: `${topic}_local`,
    handler,
    retry,
    topic,
  };
  const route = `/api/queue/${topic}`;
  const callback = getQueueProvider().createCallback(consumer);
  delivery = await startLocalQueueDelivery({
    consumers: [consumer],
    fetch: async (request) =>
      new URL(request.url).pathname === route
        ? callback(request)
        : new Response(null, { status: 404 }),
    routes: [{ route, topic }],
  });
  return delivery;
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

describe("local queue provider", () => {
  it("pushes each idempotency key once to the consumer callback", async () => {
    const topic = uniqueTopic("delivery");
    const deliveries: Array<{
      metadata: QueueMessageMetadata;
      payload: unknown;
    }> = [];
    await startConsumer(topic, async (payload, metadata) => {
      deliveries.push({ metadata, payload });
    });

    const provider = getQueueProvider();
    expect(provider.messagingSystem).toBe("pg-boss");
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
        metadata: {
          consumerGroup: `${topic}_local`,
          createdAt: expect.any(Date),
          deliveryCount: 1,
          messageId: first.messageId,
          topicName: topic,
        },
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
    await waitFor(() => acknowledged, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(deliveryCounts).toEqual([1, 2, 3]);
  }, 30_000);

  it("waits for the delay before the first delivery", async () => {
    const topic = uniqueTopic("delay");
    let deliveredAt: number | undefined;
    await startConsumer(topic, async () => {
      deliveredAt = Date.now();
    });

    const sentAt = Date.now();
    await getQueueProvider().send(topic, {}, { delaySeconds: 2 });
    await waitFor(() => deliveredAt !== undefined, 10_000);

    expect(deliveredAt! - sentAt).toBeGreaterThanOrEqual(2_000);
  });

  it("drops a message that is not delivered within its retention", async () => {
    const topic = uniqueTopic("retention");
    const payloads: unknown[] = [];
    await startConsumer(topic, async (payload) => {
      payloads.push(payload);
    });

    const provider = getQueueProvider();
    await provider.send(
      topic,
      { kept: false },
      { delaySeconds: 2, retentionSeconds: 1 },
    );
    await provider.send(topic, { kept: true }, { delaySeconds: 2 });
    await waitFor(() => payloads.length > 0, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(payloads).toEqual([{ kept: true }]);
  }, 15_000);

  it("runs slow messages at the same time", async () => {
    const topic = uniqueTopic("concurrency");
    let running = 0;
    let mostRunning = 0;
    let finished = 0;
    await startConsumer(topic, async () => {
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
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
    delivery = undefined;

    expect(finished).toBe(true);
  });

  it("rejects a push without delivery headers", async () => {
    const callback = getQueueProvider().createCallback({
      consumerGroup: "group",
      handler: async () => undefined,
      retry: () => undefined,
      topic: "topic",
    });

    const response = await callback(
      new Request("http://localhost/api/queue", {
        body: "{}",
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
  });
});
