import { describe, expect, it, vi } from "vitest";
import type { StateAdapter } from "chat";
import { StateAdapterTokenStore } from "@/chat/credentials/state-adapter-token-store";

describe("StateAdapterTokenStore", () => {
  it("uses a long-lived ttl for tokens without expiresAt", async () => {
    const set = vi.fn(async () => {});
    const adapter = {
      get: async () => null,
      set,
      delete: async () => {},
      acquireLock: async () => ({ key: "lock", lockId: "lock-id" }),
      connect: async () => {},
      disconnect: async () => {},
      extendLock: async () => true,
      getSetMembers: async () => [],
      getWithTtl: async () => null,
      releaseLock: async () => {},
      setWithTtl: async () => {},
    } as unknown as StateAdapter;
    const store = new StateAdapterTokenStore(adapter);

    await store.set("U123", "notion", {
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });

    expect(set).toHaveBeenCalledWith(
      "oauth-token:U123:notion",
      {
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
      365 * 24 * 60 * 60 * 1000,
    );
  });
});
