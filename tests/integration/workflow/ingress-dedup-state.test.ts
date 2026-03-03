import { beforeEach, describe, expect, it, vi } from "vitest";

function createRedisState(setResult: "OK" | null) {
  const set = vi.fn(async () => setResult);
  return {
    adapter: {
      connect: vi.fn(),
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
      getClient: vi.fn(() => ({ set }))
    },
    set
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
    expect(redis.set).toHaveBeenCalledTimes(1);
  });
});
