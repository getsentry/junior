import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startLocalVercelQueueServer,
  type LocalVercelQueueServer,
} from "@/chat/queue/local-server";
import {
  getQueueProvider,
  type QueueConsumer,
  type QueueMessageMetadata,
} from "@/chat/queue/provider";

// Chat config reads the queue API URL when it loads, so pick the port first.
// Each test starts its own server on this port.
const { port } = await vi.hoisted(async () => {
  const { createServer: createPortProbe } = await import("node:net");
  const probe = createPortProbe();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("No free port for the local queue server");
  }
  process.env["JUNIOR_QUEUE_PROVIDER"] = "vercel";
  process.env["JUNIOR_QUEUE_API_URL"] = `http://127.0.0.1:${address.port}`;
  return { port: address.port };
});

let server: LocalVercelQueueServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function uniqueTopic(name: string): string {
  return `junior_test_${name}_${randomUUID()}`;
}

// Push messages to the consumer's callback the way the app routes them.
async function startConsumer(
  topic: string,
  handler: QueueConsumer["handler"],
  retry: QueueConsumer["retry"] = () => undefined,
): Promise<LocalVercelQueueServer> {
  const consumer: QueueConsumer = {
    consumerGroup: `${topic}_local`,
    handler,
    retry,
    topic,
  };
  const url = `http://app.localhost/api/queue/${topic}`;
  const callback = getQueueProvider().createCallback(consumer);
  server = await startLocalVercelQueueServer({
    consumers: [{ consumerGroup: consumer.consumerGroup, topic, url }],
    fetch: async (request) =>
      request.url === url
        ? callback(request)
        : new Response(null, { status: 404 }),
    // The SDK leases each message for at least 30 seconds.
    maxLeaseSeconds: 1,
    port,
  });
  return server;
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

describe("Vercel queue provider on the local queue server", () => {
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
    expect(provider.messagingSystem).toBe("vercel_queue");
    const key = `message:conversation_1:${Date.now()}`;
    const first = await provider.send(topic, { n: 1 }, { idempotencyKey: key });
    await provider.send(topic, { n: 2 }, { idempotencyKey: key });
    await waitFor(() => deliveries.length > 0);
    await provider.send(topic, { n: 3 }, { idempotencyKey: key });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(deliveries).toEqual([
      {
        metadata: expect.objectContaining({
          consumerGroup: `${topic}_local`,
          createdAt: expect.any(Date),
          deliveryCount: 1,
          messageId: first.messageId,
          topicName: topic,
        }),
        payload: { n: 1 },
      },
    ]);
  });

  it("pushes again after the lease expires until retry() acknowledges", async () => {
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
    await waitFor(() => acknowledged, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(deliveryCounts).toEqual([1, 2, 3]);
  }, 15_000);

  it("waits for the delay before the first push", async () => {
    const topic = uniqueTopic("delay");
    let deliveredAt: number | undefined;
    await startConsumer(topic, async () => {
      deliveredAt = Date.now();
    });

    const sentAt = Date.now();
    await getQueueProvider().send(topic, {}, { delaySeconds: 2 });
    await waitFor(() => deliveredAt !== undefined);

    expect((deliveredAt ?? 0) - sentAt).toBeGreaterThanOrEqual(2_000);
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
    await waitFor(() => payloads.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(payloads).toEqual([{ kept: true }]);
  });

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
    server = undefined;

    expect(finished).toBe(true);
  });
});
