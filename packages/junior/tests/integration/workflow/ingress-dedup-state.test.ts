import { beforeEach, describe, expect, it, vi } from "vitest";

function createRedisState(setResult: "OK" | null, evalResult = 1) {
  const set = vi.fn(async () => setResult);
  const evalFn = vi.fn(async () => evalResult);
  const connect = vi.fn(async () => undefined);
  return {
    adapter: {
      connect,
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      isSubscribed: vi.fn(async () => false),
      acquireLock: vi.fn(async () => null),
      releaseLock: vi.fn(async () => undefined),
      extendLock: vi.fn(async () => true),
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      getClient: vi.fn(() => ({ set, eval: evalFn }))
    },
    connect,
    set,
    evalFn
  };
}

describe("claimWorkflowIngressDedup", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  it("claims ingress dedupe keys via Redis SET NX PX with expected prefix", async () => {
    const redis = createRedisState("OK");
    vi.doMock("@chat-adapter/state-redis", () => ({
      createRedisState: vi.fn(() => redis.adapter)
    }));
    vi.doMock("@/chat/config", () => ({
      hasRedisConfig: vi.fn(() => true)
    }));
    vi.doMock("@/chat/observability", () => ({
      logInfo: vi.fn()
    }));

    const { claimWorkflowIngressDedup } = await import("@/chat/state");
    const claimed = await claimWorkflowIngressDedup("slack:C123:1700000000.100:1700000000.200", 30_000);

    expect(claimed).toBe(true);
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      "junior:workflow_ingress:slack:C123:1700000000.100:1700000000.200",
      "1",
      {
        NX: true,
        PX: 30_000
      }
    );
  });

  it("returns false when Redis reports key already claimed", async () => {
    const redis = createRedisState(null);
    vi.doMock("@chat-adapter/state-redis", () => ({
      createRedisState: vi.fn(() => redis.adapter)
    }));
    vi.doMock("@/chat/config", () => ({
      hasRedisConfig: vi.fn(() => true)
    }));
    vi.doMock("@/chat/observability", () => ({
      logInfo: vi.fn()
    }));

    const { claimWorkflowIngressDedup } = await import("@/chat/state");
    const claimed = await claimWorkflowIngressDedup("slack:C123:1700000000.100:1700000000.200", 30_000);

    expect(claimed).toBe(false);
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });
});

describe("workflow startup lease helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  it("claims startup lease keys via Redis SET NX PX with expected prefix", async () => {
    const redis = createRedisState("OK");
    vi.doMock("@chat-adapter/state-redis", () => ({
      createRedisState: vi.fn(() => redis.adapter)
    }));
    vi.doMock("@/chat/config", () => ({
      hasRedisConfig: vi.fn(() => true)
    }));
    vi.doMock("@/chat/observability", () => ({
      logInfo: vi.fn()
    }));

    const { claimWorkflowStartupLease } = await import("@/chat/state");
    const claimed = await claimWorkflowStartupLease("slack:C123:1700000000.100", "lease-token-1", 3000);

    expect(claimed).toBe(true);
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith("junior:workflow_startup:slack:C123:1700000000.100", "lease-token-1", {
      NX: true,
      PX: 3000
    });
  });

  it("releases startup lease only when owner token matches", async () => {
    const redis = createRedisState("OK", 1);
    vi.doMock("@chat-adapter/state-redis", () => ({
      createRedisState: vi.fn(() => redis.adapter)
    }));
    vi.doMock("@/chat/config", () => ({
      hasRedisConfig: vi.fn(() => true)
    }));
    vi.doMock("@/chat/observability", () => ({
      logInfo: vi.fn()
    }));

    const { releaseWorkflowStartupLease } = await import("@/chat/state");
    const released = await releaseWorkflowStartupLease("slack:C123:1700000000.100", "lease-token-1");

    expect(released).toBe(true);
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.evalFn).toHaveBeenCalledTimes(1);
    expect(redis.evalFn).toHaveBeenCalledWith(expect.any(String), {
      keys: ["junior:workflow_startup:slack:C123:1700000000.100"],
      arguments: ["lease-token-1"]
    });
  });
});

describe("workflow message processing helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  it("marks message processing started via Redis SET NX PX", async () => {
    const redis = createRedisState("OK");
    vi.doMock("@chat-adapter/state-redis", () => ({
      createRedisState: vi.fn(() => redis.adapter)
    }));
    vi.doMock("@/chat/config", () => ({
      hasRedisConfig: vi.fn(() => true)
    }));
    vi.doMock("@/chat/observability", () => ({
      logInfo: vi.fn()
    }));

    const { markWorkflowMessageStarted } = await import("@/chat/state");
    const started = await markWorkflowMessageStarted(
      "slack:C123:1700000000.100:1700000000.200",
      "wrun-123"
    );

    expect(started).toBe(true);
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      "junior:workflow_message:slack:C123:1700000000.100:1700000000.200",
      expect.any(String),
      expect.objectContaining({
        NX: true
      })
    );
  });

  it("reads message processing state from adapter state", async () => {
    const redis = createRedisState("OK");
    redis.adapter.get = vi.fn(async () =>
      JSON.stringify({
        status: "completed",
        updatedAtMs: 1700000000000,
        workflowRunId: "wrun-456"
      })
    );
    vi.doMock("@chat-adapter/state-redis", () => ({
      createRedisState: vi.fn(() => redis.adapter)
    }));
    vi.doMock("@/chat/config", () => ({
      hasRedisConfig: vi.fn(() => true)
    }));
    vi.doMock("@/chat/observability", () => ({
      logInfo: vi.fn()
    }));

    const { getWorkflowMessageProcessingState } = await import("@/chat/state");
    const state = await getWorkflowMessageProcessingState("slack:C123:1700000000.100:1700000000.200");

    expect(state).toEqual({
      status: "completed",
      updatedAtMs: 1700000000000,
      workflowRunId: "wrun-456"
    });
  });

  it("marks message processing completed in adapter state", async () => {
    const redis = createRedisState("OK");
    vi.doMock("@chat-adapter/state-redis", () => ({
      createRedisState: vi.fn(() => redis.adapter)
    }));
    vi.doMock("@/chat/config", () => ({
      hasRedisConfig: vi.fn(() => true)
    }));
    vi.doMock("@/chat/observability", () => ({
      logInfo: vi.fn()
    }));

    const { markWorkflowMessageCompleted } = await import("@/chat/state");
    await markWorkflowMessageCompleted("slack:C123:1700000000.100:1700000000.200", "wrun-789");

    expect(redis.adapter.set).toHaveBeenCalledWith(
      "junior:workflow_message:slack:C123:1700000000.100:1700000000.200",
      expect.any(String),
      expect.any(Number)
    );
  });
});
