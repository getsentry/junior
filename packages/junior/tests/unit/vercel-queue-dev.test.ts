import { afterEach, describe, expect, it, vi } from "vitest";

const originalNodeEnv = process.env.NODE_ENV;
const originalQueueTopic = process.env.JUNIOR_CONVERSATION_WORK_QUEUE_TOPIC;
const originalJuniorSecret = process.env.JUNIOR_SECRET;

afterEach(async () => {
  const { disconnectStateAdapter } = await import("@/chat/state/adapter");
  await disconnectStateAdapter();
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

  it("absorbs rejected conversation queue messages before retry", async () => {
    const routeHandler = vi.fn();
    const handleCallback = vi.fn(() => routeHandler);

    vi.doMock("@vercel/queue", () => ({
      QueueClient: vi.fn(),
      handleCallback,
      registerDevConsumer: vi.fn(),
    }));

    const { createVercelConversationWorkCallback } =
      await import("@/chat/task-execution/vercel-callback");

    const run = vi.fn(async () => ({ status: "completed" as const }));
    expect(
      createVercelConversationWorkCallback({
        run,
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
          (message: unknown, metadata: TestQueueMetadata) => Promise<void>,
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

    await expect(
      handler({ conversationId: "slack:C123:1712345.0001" }, metadata),
    ).resolves.toBeUndefined();

    const [{ appendInboundMessage }, { signConversationQueueMessage }] =
      await Promise.all([
        import("@/chat/task-execution/store"),
        import("@/chat/task-execution/queue-signing"),
      ]);
    process.env.JUNIOR_SECRET = "conversation-work-secret";
    await appendInboundMessage({
      message: {
        conversationId: "slack:C123:1712345.0001",
        inboundMessageId: "m1",
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        source: "slack",
        createdAtMs: 1_000,
        receivedAtMs: 1_100,
        input: {
          authorId: "U123",
          text: "message m1",
        },
      },
      nowMs: 1_200,
    });
    await expect(
      handler(
        signConversationQueueMessage({
          conversationId: "slack:C123:1712345.0001",
          destination: {
            channelId: "C456",
            platform: "slack",
            teamId: "T123",
          },
        }),
        metadata,
      ),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();

    delete process.env.JUNIOR_SECRET;
    let missingSecretError: unknown;
    await handler(
      {
        conversationId: "slack:C123:1712345.0001",
        destination: { channelId: "C123", platform: "slack", teamId: "T123" },
        signature: "signature",
        signatureVersion: "v1",
        signedAtMs: 1_000,
      },
      metadata,
    ).catch((error: unknown) => {
      missingSecretError = error;
    });
    expect(missingSecretError).toMatchObject({
      message:
        "Conversation queue message verification unavailable: missing_secret",
    });
    expect(retry(missingSecretError, metadata)).toBeUndefined();
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
