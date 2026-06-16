import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestMessage } from "../../fixtures/slack-harness";

const ORIGINAL_ENV = { ...process.env };

type StateAdapterModule = typeof import("@/chat/state/adapter");

let stateAdapterModule: StateAdapterModule | undefined;

async function loadMemoryStateAdapter(
  env: Record<string, string> = {},
): Promise<StateAdapterModule> {
  process.env = {
    ...ORIGINAL_ENV,
    JUNIOR_STATE_ADAPTER: "memory",
    ...env,
  };
  vi.resetModules();
  stateAdapterModule = await import("@/chat/state/adapter");
  return stateAdapterModule;
}

describe("state adapter lock lease", () => {
  afterEach(async () => {
    await stateAdapterModule?.disconnectStateAdapter();
    stateAdapterModule = undefined;
    process.env = { ...ORIGINAL_ENV };
    vi.useRealTimers();
    vi.resetModules();
  });

  it("keeps an active SDK-sized lock leased past the old static ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { disconnectStateAdapter, getStateAdapter } =
      await loadMemoryStateAdapter();
    const adapter = getStateAdapter();
    await adapter.connect();

    const lock = await adapter.acquireLock("thread-1", 30_000);
    expect(lock).not.toBeNull();
    if (!lock) {
      return;
    }

    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

    await expect(adapter.acquireLock("thread-1", 30_000)).resolves.toBeNull();

    await adapter.releaseLock(lock);
    const nextLock = await adapter.acquireLock("thread-1", 30_000);
    expect(nextLock).not.toBeNull();
    if (nextLock) {
      await adapter.releaseLock(nextLock);
    }
    await disconnectStateAdapter();
  });

  it("stops the heartbeat when the lock is released", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { getStateAdapter } = await loadMemoryStateAdapter();
    const adapter = getStateAdapter();
    await adapter.connect();

    const lock = await adapter.acquireLock("thread-1", 30_000);
    expect(lock).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    if (lock) {
      await adapter.releaseLock(lock);
    }

    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops heartbeating active locks after the configured turn window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { getStateAdapter } = await loadMemoryStateAdapter({
      AGENT_TURN_TIMEOUT_MS: "10000",
    });
    const adapter = getStateAdapter();
    await adapter.connect();

    const lock = await adapter.acquireLock("thread-1", 30_000);
    expect(lock).not.toBeNull();
    if (!lock) {
      return;
    }

    await vi.advanceTimersByTimeAsync(181_000);

    const nextLock = await adapter.acquireLock("thread-1", 30_000);
    expect(nextLock).not.toBeNull();
    if (nextLock) {
      await adapter.releaseLock(nextLock);
    }
  });

  it("does not heartbeat locks that request a longer explicit ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const { getStateAdapter } = await loadMemoryStateAdapter();
    const adapter = getStateAdapter();
    await adapter.connect();

    const lock = await adapter.acquireLock("snapshot-lock", 10 * 60 * 1000);
    expect(lock).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    if (lock) {
      await adapter.releaseLock(lock);
    }
  });

  it("keeps caller-facing lock and queue identifiers unprefixed", async () => {
    const { getStateAdapter } = await loadMemoryStateAdapter({
      JUNIOR_STATE_KEY_PREFIX: "junior:test:state-adapter-lock",
    });
    const adapter = getStateAdapter();
    await adapter.connect();

    await adapter.set("logical-key", "stored");
    await expect(adapter.get("logical-key")).resolves.toBe("stored");

    const lock = await adapter.acquireLock("thread-1", 10 * 60 * 1000);
    expect(lock).toMatchObject({ threadId: "thread-1" });
    if (lock) {
      await adapter.releaseLock(lock);
    }

    const entry: Parameters<typeof adapter.enqueue>[1] = {
      enqueuedAt: 0,
      expiresAt: 60_000,
      message: createTestMessage({ id: "entry-1" }),
    };
    await adapter.enqueue("thread-1", entry, 10);
    await expect(adapter.queueDepth("thread-1")).resolves.toBe(1);
    await expect(adapter.dequeue("thread-1")).resolves.toMatchObject({
      message: { id: "entry-1" },
    });
  });
});
