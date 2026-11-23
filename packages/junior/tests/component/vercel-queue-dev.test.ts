import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MessageMetadata,
  handleCallback,
  registerDevConsumer,
} from "@vercel/queue";
import {
  getChatConfig,
  resetRuntimeConfig,
  restoreRuntimeConfig,
  snapshotRuntimeConfig,
} from "@/chat/config";
import {
  PLUGIN_TASK_QUEUE_TOPIC,
  createVercelPluginTaskCallback,
  pluginTaskId,
  sendVercelPluginTask,
  signPluginTaskQueueMessage,
} from "@/chat/plugins/task-queue";
import {
  createVercelWorkspaceSnapshotJobCallback,
  registerVercelWorkspaceSnapshotJobDevConsumer,
} from "@/chat/sandbox/snapshot/job-callback";
import {
  sendNextWorkspaceSnapshotJob,
  sendWorkspaceSnapshotJob,
} from "@/chat/sandbox/snapshot/job-queue";
import {
  CONVERSATION_WORK_DEV_CONSUMER_GROUP,
  createVercelConversationWorkCallback,
  registerVercelConversationWorkDevConsumer,
} from "@/chat/task-execution/vercel-callback";
import {
  createGatewayModelClient,
  turnStepConsumer,
} from "@/turn-steps/consumer";
import { createEngineContext } from "@/turn-steps/engine-context";

// Mock the SDK once for the file and import statically. Per-test
// `vi.doMock` needs `vi.resetModules`, and then a parallel import can load
// the real SDK.
const mocks = vi.hoisted(() => {
  const send = vi.fn(
    async (
      _topic: string,
      _message: Record<string, unknown>,
      _options?: { idempotencyKey?: string; retentionSeconds: number },
    ) => ({ messageId: "msg_1" }),
  );
  return {
    send,
    queueClient: { send },
    handleCallback: vi.fn<typeof handleCallback>(),
    registerDevConsumer: vi.fn<typeof registerDevConsumer>(),
    processPluginTask: vi.fn(async (_message: unknown) => undefined),
    processWorkspaceSnapshotJob: vi.fn(async (_message: unknown) => undefined),
  };
});

vi.mock("@vercel/queue", () => ({
  QueueClient: vi.fn(function QueueClientMock() {
    return mocks.queueClient;
  }),
  handleCallback: mocks.handleCallback,
  registerDevConsumer: mocks.registerDevConsumer,
}));
vi.mock("@/chat/plugins/task-runner", () => ({
  processPluginTask: mocks.processPluginTask,
}));
vi.mock("@/chat/sandbox/snapshot/job-runner", () => ({
  processWorkspaceSnapshotJob: mocks.processWorkspaceSnapshotJob,
}));

const originalNodeEnv = process.env["NODE_ENV"];
const originalJuniorSecret = process.env["JUNIOR_SECRET"];
const originalConversationWorkEnabled =
  process.env["JUNIOR_CONVERSATION_WORK_ENABLED"];

afterEach(() => {
  vi.clearAllMocks();
  process.env["NODE_ENV"] = originalNodeEnv;
  if (originalJuniorSecret === undefined) {
    delete process.env["JUNIOR_SECRET"];
  } else {
    process.env["JUNIOR_SECRET"] = originalJuniorSecret;
  }
  if (originalConversationWorkEnabled === undefined) {
    delete process.env["JUNIOR_CONVERSATION_WORK_ENABLED"];
  } else {
    process.env["JUNIOR_CONVERSATION_WORK_ENABLED"] =
      originalConversationWorkEnabled;
  }
});

function queueMetadata(overrides: Partial<MessageMetadata> = {}) {
  return {
    consumerGroup: "consumer",
    createdAt: new Date(1_000),
    deliveryCount: 1,
    expiresAt: new Date(2_000),
    messageId: "msg_1",
    region: "iad1",
    topicName: "topic",
    ...overrides,
  } satisfies MessageMetadata;
}

/** Return the handler and retry hook passed to the last `handleCallback`. */
function lastPushCallback() {
  const call = mocks.handleCallback.mock.lastCall;
  const handler = call?.[0];
  const retry = call?.[1]?.retry;
  if (!handler || !retry) {
    throw new Error("Expected a queue handler and retry hook");
  }
  return { handler, retry };
}

describe("Workspace snapshot Vercel queue integration", () => {
  it("runs only messages signed by the snapshot queue sender", async () => {
    const routeHandler = vi.fn(async () => new Response());
    mocks.handleCallback.mockReturnValueOnce(routeHandler);
    const unregister = vi.fn();
    mocks.registerDevConsumer.mockReturnValueOnce(unregister);

    expect(createVercelWorkspaceSnapshotJobCallback()).toBe(routeHandler);
    const { handler, retry } = lastPushCallback();
    const metadata = queueMetadata({
      consumerGroup: "workspace-snapshots",
      messageId: "msg_snapshot",
      topicName: "junior_workspace_snapshots",
    });
    const message = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      profileHash: "profile-hash",
    };

    await expect(handler(message, metadata)).resolves.toBeUndefined();
    expect(mocks.processWorkspaceSnapshotJob).not.toHaveBeenCalled();

    process.env["JUNIOR_SECRET"] = "workspace-snapshot-secret";
    await sendWorkspaceSnapshotJob(message);
    const signedMessage = mocks.send.mock.lastCall?.[1];
    if (!signedMessage) throw new Error("Expected signed queue message");
    await expect(handler(signedMessage, metadata)).resolves.toBeUndefined();
    expect(mocks.processWorkspaceSnapshotJob).toHaveBeenCalledWith(message);

    await expect(
      handler({ ...signedMessage, profileHash: "tampered" }, metadata),
    ).resolves.toBeUndefined();
    expect(mocks.processWorkspaceSnapshotJob).toHaveBeenCalledTimes(1);

    await sendNextWorkspaceSnapshotJob(message);
    expect(mocks.send).toHaveBeenLastCalledWith(
      "junior_workspace_snapshots",
      expect.objectContaining(message),
      { retentionSeconds: 3_600 },
    );

    expect(retry(new Error("build failed"), metadata)).toBeUndefined();
    expect(
      retry(new Error("build failed"), { ...metadata, deliveryCount: 5 }),
    ).toBeUndefined();

    process.env["NODE_ENV"] = "development";
    expect(registerVercelWorkspaceSnapshotJobDevConsumer()).toBe(unregister);
    expect(mocks.registerDevConsumer).toHaveBeenCalledWith(
      expect.objectContaining({
        client: mocks.queueClient,
        consumerGroup: "junior_workspace_snapshots_dev",
        handler: expect.any(Function),
        retry: expect.any(Function),
        topic: "junior_workspace_snapshots",
      }),
    );
  });
});

describe("plugin task Vercel queue integration", () => {
  it("passes parsed plugin task payloads through the Vercel callback", async () => {
    const routeHandler = vi.fn(async () => new Response());
    mocks.handleCallback.mockReturnValueOnce(routeHandler);

    expect(createVercelPluginTaskCallback()).toBe(routeHandler);
    const { handler, retry } = lastPushCallback();
    const metadata = queueMetadata();

    await expect(
      handler({ malformed: true }, metadata),
    ).resolves.toBeUndefined();
    expect(mocks.processPluginTask).not.toHaveBeenCalled();

    const message = {
      name: "extractMemories",
      params: {
        conversationId: "local:test:plugin-callback",
        sessionId: "turn-1",
      },
      plugin: "memory",
    };
    await expect(handler(message, metadata)).resolves.toBeUndefined();
    expect(mocks.processPluginTask).not.toHaveBeenCalled();

    process.env["JUNIOR_SECRET"] = "plugin-task-secret";
    const signedMessage = signPluginTaskQueueMessage(message);
    await expect(handler(signedMessage, metadata)).resolves.toBeUndefined();
    expect(mocks.processPluginTask).toHaveBeenCalledWith(message);

    await expect(
      handler({ ...signedMessage, unexpected: true }, metadata),
    ).resolves.toBeUndefined();
    expect(mocks.processPluginTask).toHaveBeenCalledTimes(1);

    mocks.processPluginTask.mockRejectedValueOnce(new Error("task failed"));
    await expect(handler(signedMessage, metadata)).rejects.toThrow(
      "task failed",
    );
    expect(retry(new Error("still failing"), metadata)).toBeUndefined();
    expect(
      retry(new Error("still failing"), { ...metadata, deliveryCount: 5 }),
    ).toEqual({ acknowledge: true });
  });

  it("sends plugin task messages with the derived idempotency key", async () => {
    process.env["JUNIOR_SECRET"] = "plugin-task-secret";
    const message = {
      name: "extractMemories",
      params: {
        conversationId: "local:test:plugin-send",
        sessionId: "turn-1",
      },
      plugin: "memory",
    };

    await sendVercelPluginTask(message);

    expect(mocks.send).toHaveBeenCalledWith(
      PLUGIN_TASK_QUEUE_TOPIC,
      {
        ...message,
        signedAtMs: expect.any(Number),
        signatureVersion: "v1",
        signature: expect.any(String),
      },
      {
        idempotencyKey: pluginTaskId(message),
        retentionSeconds: 3600,
      },
    );
  });
});

describe("conversation work Vercel queue integration", () => {
  it("creates the push callback with the Queue SDK", () => {
    const routeHandler = vi.fn(async () => new Response());
    mocks.handleCallback.mockReturnValueOnce(routeHandler);

    expect(
      createVercelConversationWorkCallback({
        run: vi.fn(),
        visibilityTimeoutSeconds: 45,
      }),
    ).toBe(routeHandler);
    expect(mocks.handleCallback).toHaveBeenCalledWith(expect.any(Function), {
      retry: expect.any(Function),
      visibilityTimeoutSeconds: 45,
    });
  });

  it("registers the local Nitro consumer with the Queue SDK", () => {
    const unregister = vi.fn();
    mocks.registerDevConsumer.mockReturnValueOnce(unregister);
    process.env["NODE_ENV"] = "development";

    const result = registerVercelConversationWorkDevConsumer({
      run: vi.fn(),
      topic: "local_work",
      visibilityTimeoutSeconds: 45,
    });

    expect(result).toBe(unregister);
    expect(mocks.registerDevConsumer).toHaveBeenCalledWith({
      client: mocks.queueClient,
      consumerGroup: CONVERSATION_WORK_DEV_CONSUMER_GROUP,
      handler: expect.any(Function),
      retry: expect.any(Function),
      topic: "local_work",
      visibilityTimeoutSeconds: 45,
    });
  });

  it("acks disabled conversation work before sign checks", async () => {
    process.env["JUNIOR_CONVERSATION_WORK_ENABLED"] = "false";
    delete process.env["JUNIOR_SECRET"];
    // Config reads the kill switch when it loads, so load a fresh copy.
    vi.resetModules();
    const { conversationWorkQueueConsumer } =
      await import("@/chat/task-execution/vercel-callback");
    const run = vi.fn();

    await expect(
      conversationWorkQueueConsumer({ run }).handler(
        {
          schemaVersion: 2,
          conversationId: "slack:C123:1712345.0001",
          signature: "signature",
          signatureVersion: "v2",
          signedAtMs: 1_000,
        },
        queueMetadata({ deliveryCount: 3 }),
      ),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not register outside local development", () => {
    process.env["NODE_ENV"] = "test";

    expect(
      registerVercelConversationWorkDevConsumer({ run: vi.fn() }),
    ).toBeUndefined();
    expect(mocks.registerDevConsumer).not.toHaveBeenCalled();
  });
});

describe("Turn step Vercel queue integration", () => {
  const runtimeConfig = snapshotRuntimeConfig();
  afterEach(() => {
    restoreRuntimeConfig(runtimeConfig);
  });

  it("uses the app's max duration in the visibility timeout", () => {
    // createApp sets the host's max duration after this module loads.
    resetRuntimeConfig(600);

    const engineCtx = createEngineContext(getChatConfig());
    engineCtx.queue.createCallback(
      turnStepConsumer(engineCtx, { client: createGatewayModelClient() }),
    );

    expect(mocks.handleCallback).toHaveBeenCalledWith(expect.any(Function), {
      retry: expect.any(Function),
      visibilityTimeoutSeconds: 630,
    });
  });
});
