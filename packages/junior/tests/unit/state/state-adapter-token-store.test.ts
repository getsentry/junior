import { describe, expect, it, vi } from "vitest";
import type { StateAdapter } from "chat";
import { StateAdapterTokenStore } from "@/chat/credentials/state-adapter-token-store";

describe("StateAdapterTokenStore", () => {
  function createAdapter(overrides: Partial<StateAdapter> = {}) {
    return {
      get: async () => null,
      set: vi.fn(async () => {}),
      delete: async () => {},
      acquireLock: async () => ({ key: "lock", lockId: "lock-id" }),
      connect: async () => {},
      disconnect: async () => {},
      extendLock: async () => true,
      getSetMembers: async () => [],
      getWithTtl: async () => null,
      releaseLock: async () => {},
      setWithTtl: async () => {},
      ...overrides,
    } as unknown as StateAdapter & {
      set: ReturnType<typeof vi.fn>;
    };
  }

  it("uses a long-lived ttl for tokens without expiresAt", async () => {
    const adapter = createAdapter();
    const store = new StateAdapterTokenStore(adapter);

    await store.set("U123", "notion", {
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });

    expect(adapter.set).toHaveBeenCalledWith(
      "oauth-token:U123:notion",
      {
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
      365 * 24 * 60 * 60 * 1000,
    );
  });

  it("uses refresh token expiry instead of access token expiry for ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T00:00:00Z"));
    const adapter = createAdapter();
    const store = new StateAdapterTokenStore(adapter);

    try {
      await store.set("U123", "github", {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
        refreshTokenExpiresAt: Date.now() + 180 * 24 * 60 * 60 * 1000,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(adapter.set).toHaveBeenCalledWith(
      "oauth-token:U123:github",
      {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: new Date("2026-06-24T08:00:00Z").getTime(),
        refreshTokenExpiresAt: new Date("2026-12-21T00:00:00Z").getTime(),
      },
      181 * 24 * 60 * 60 * 1000,
    );
  });

  it("waits for the refresh lock before running the callback", async () => {
    const lock = { key: "oauth-token:U123:github:refresh", lockId: "lock-id" };
    const acquireLock = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(lock);
    const releaseLock = vi.fn(async () => {});
    const adapter = createAdapter({ acquireLock, releaseLock });
    const store = new StateAdapterTokenStore(adapter);
    const callback = vi.fn(async () => "refreshed");

    await expect(store.withRefresh("U123", "github", callback)).resolves.toBe(
      "refreshed",
    );

    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(acquireLock).toHaveBeenCalledWith(
      "oauth-token:U123:github:refresh",
      30_000,
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledWith(lock);
  });
});
