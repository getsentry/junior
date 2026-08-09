import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fenceLock, MUTATION_LOCK_TTL_MS, withLock } from "@/chat/state/locks";

describe("state locks", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops a stale owner before it can overwrite newer state", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const state = createMemoryState();
    const writeSql = vi.fn();
    await state.connect();

    const mutation = withLock(
      state,
      "turn",
      async (lock) => {
        vi.setSystemTime(1_000 + MUTATION_LOCK_TTL_MS + 1);
        const newer = await state.acquireLock("turn", MUTATION_LOCK_TTL_MS);
        expect(newer).not.toBeNull();
        await state.set("record", "newer", 60_000);

        await fenceLock(state, lock);
        await writeSql();
        await state.set("record", "stale", 60_000);
      },
      { ttlMs: MUTATION_LOCK_TTL_MS },
    );

    await expect(mutation).rejects.toThrow(
      "Lock ownership was lost before write",
    );
    await expect(state.get("record")).resolves.toBe("newer");
    expect(writeSql).not.toHaveBeenCalled();
    await state.disconnect();
  });
});
