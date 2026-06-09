import { afterEach, describe, expect, it, vi } from "vitest";

const originalNodeEnv = process.env.NODE_ENV;
const originalQueueTopic = process.env.JUNIOR_CONVERSATION_WORK_QUEUE_TOPIC;
const originalJuniorSecret = process.env.JUNIOR_SECRET;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalQueueTopic === undefined) {
    delete process.env.JUNIOR_CONVERSATION_WORK_QUEUE_TOPIC;
  } else {
    process.env.JUNIOR_CONVERSATION_WORK_QUEUE_TOPIC = originalQueueTopic;
  }
  if (originalJuniorSecret === undefined) {
    delete process.env.JUNIOR_SECRET;
  } else {
    process.env.JUNIOR_SECRET = originalJuniorSecret;
  }
  vi.doUnmock("@vercel/queue");
  vi.resetModules();
});

describe("registerVercelConversationWorkDevConsumer", () => {
  it("registers the local Nitro consumer with the Queue SDK", async () => {
    const queueClient = {};
    const QueueClient = vi.fn(function QueueClientMock() {
      return queueClient;
    });
    const unregister = vi.fn();
    const registerDevConsumer = vi.fn(() => unregister);

    vi.doMock("@vercel/queue", () => ({
      QueueClient,
      handleCallback: vi.fn(),
      registerDevConsumer,
    }));

    process.env.NODE_ENV = "development";
    process.env.JUNIOR_CONVERSATION_WORK_QUEUE_TOPIC = "local_work";

    const {
      CONVERSATION_WORK_DEV_CONSUMER_GROUP,
      registerVercelConversationWorkDevConsumer,
    } = await import("@/chat/task-execution/vercel-callback");

    const run = vi.fn();
    const result = registerVercelConversationWorkDevConsumer({
      run,
      visibilityTimeoutSeconds: 45,
    });

    expect(result).toBe(unregister);
    expect(registerDevConsumer).toHaveBeenCalledWith({
      client: queueClient,
      consumerGroup: CONVERSATION_WORK_DEV_CONSUMER_GROUP,
      handler: expect.any(Function),
      retry: expect.any(Function),
      topic: "local_work",
      visibilityTimeoutSeconds: 45,
    });
  });

  it("acknowledges rejected conversation queue messages only", async () => {
    const routeHandler = vi.fn();
    const handleCallback = vi.fn(() => routeHandler);

    vi.doMock("@vercel/queue", () => ({
      QueueClient: vi.fn(),
      handleCallback,
      registerDevConsumer: vi.fn(),
    }));

    const { createVercelConversationWorkCallback } =
      await import("@/chat/task-execution/vercel-callback");

    expect(
      createVercelConversationWorkCallback({
        run: vi.fn(),
        visibilityTimeoutSeconds: 45,
      }),
    ).toBe(routeHandler);

    type TestQueueMetadata = {
      consumerGroup: string;
      createdAt: Date;
      deliveryCount: number;
      expiresAt: Date;
      messageId: string;
      region: string;
      topicName: string;
    };
    const metadata: TestQueueMetadata = {
      consumerGroup: "consumer",
      createdAt: new Date(1_000),
      deliveryCount: 3,
      expiresAt: new Date(2_000),
      messageId: "msg_1",
      region: "iad1",
      topicName: "topic",
    };
    const call = handleCallback.mock.calls[0] as unknown as
      | [
          (message: unknown) => Promise<void>,
          {
            retry?: (error: unknown, metadata: TestQueueMetadata) => unknown;
            visibilityTimeoutSeconds?: number;
          },
        ]
      | undefined;
    const handler = call?.[0];
    const retry = call?.[1].retry;
    expect(handler).toEqual(expect.any(Function));
    expect(retry).toEqual(expect.any(Function));
    if (!handler || !retry) {
      throw new Error("Expected conversation queue handler and retry hook");
    }

    let rejectedError: unknown;
    await handler({ conversationId: "slack:C123:1712345.0001" }).catch(
      (error: unknown) => {
        rejectedError = error;
      },
    );
    expect(rejectedError).toBeInstanceOf(Error);
    expect(retry(rejectedError, metadata)).toEqual({ acknowledge: true });

    delete process.env.JUNIOR_SECRET;
    let unavailableError: unknown;
    await handler({
      conversationId: "slack:C123:1712345.0001",
      destination: { channelId: "C123", platform: "slack", teamId: "T123" },
      signature: "signature",
      signatureVersion: "v1",
      signedAtMs: 1_000,
    }).catch((error: unknown) => {
      unavailableError = error;
    });
    if (!unavailableError) {
      throw new Error("Expected unavailable verification error");
    }
    expect(retry(unavailableError, metadata)).toBeUndefined();
    expect(retry(new Error("runner failed"), metadata)).toBeUndefined();
  });

  it("does not register outside local development", async () => {
    const registerDevConsumer = vi.fn();

    vi.doMock("@vercel/queue", () => ({
      QueueClient: vi.fn(),
      handleCallback: vi.fn(),
      registerDevConsumer,
    }));

    process.env.NODE_ENV = "test";

    const { registerVercelConversationWorkDevConsumer } =
      await import("@/chat/task-execution/vercel-callback");

    const result = registerVercelConversationWorkDevConsumer({
      run: vi.fn(),
    });

    expect(result).toBeUndefined();
    expect(registerDevConsumer).not.toHaveBeenCalled();
  });
});
