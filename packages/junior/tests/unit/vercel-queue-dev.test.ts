import { afterEach, describe, expect, it, vi } from "vitest";

const originalNodeEnv = process.env.NODE_ENV;
const originalQueueTopic = process.env.JUNIOR_CONVERSATION_WORK_QUEUE_TOPIC;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalQueueTopic === undefined) {
    delete process.env.JUNIOR_CONVERSATION_WORK_QUEUE_TOPIC;
  } else {
    process.env.JUNIOR_CONVERSATION_WORK_QUEUE_TOPIC = originalQueueTopic;
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
      topic: "local_work",
      visibilityTimeoutSeconds: 45,
    });
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
