import { describe, expect, it, vi } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter } from "chat";
import { StateAdapterTokenStore } from "@/chat/credentials/state-adapter-token-store";
import { readEncryptionKeyring } from "@/chat/encryption/keyring";
import { encryptSecret } from "@/chat/encryption/secret";
import { ACTIVE_LOCK_TTL_MS } from "@/chat/state/locks";

describe("StateAdapterTokenStore", () => {
  function createAdapter(overrides: Partial<StateAdapter> = {}) {
    const adapter = {
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
    };
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    return adapter as StateAdapter & { set: ReturnType<typeof vi.fn> };
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
      expect.stringMatching(/^jenc:v1:/),
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
      expect.stringMatching(/^jenc:v1:/),
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
      ACTIVE_LOCK_TTL_MS,
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledWith(lock);
  });

  it("saves tokens encrypted and reads them back", async () => {
    const state = createMemoryState();
    await state.connect();
    const store = new StateAdapterTokenStore(state);
    const tokens = { accessToken: "access-token", refreshToken: "refresh" };

    await store.set("U123", "notion", tokens);

    const stored = await state.get<string>("oauth-token:U123:notion");
    expect(stored).toMatch(/^jenc:v1:/);
    expect(stored).not.toContain("access-token");
    await expect(store.get("U123", "notion")).resolves.toEqual(tokens);
  });

  it("encrypts plaintext tokens saved before encryption on read", async () => {
    const state = createMemoryState();
    await state.connect();
    const tokens = { accessToken: "access-token", refreshToken: "refresh" };
    await state.set("oauth-token:U123:notion", tokens);
    const store = new StateAdapterTokenStore(state);

    await expect(store.get("U123", "notion")).resolves.toEqual(tokens);

    expect(await state.get("oauth-token:U123:notion")).toMatch(/^jenc:v1:/);
    await expect(store.get("U123", "notion")).resolves.toEqual(tokens);
  });

  it("moves tokens from a key that is not active on read", async () => {
    const state = createMemoryState();
    await state.connect();
    const tokens = { accessToken: "access-token", refreshToken: "refresh" };
    const oldKeyOnly = readEncryptionKeyring({
      JUNIOR_ENCRYPTION_KEYS: process.env["JUNIOR_ENCRYPTION_KEYS"],
      JUNIOR_ENCRYPTION_KEY_ID: "test-old",
    });
    await state.set(
      "oauth-token:U123:notion",
      encryptSecret(
        JSON.stringify(tokens),
        "oauth-token:U123:notion",
        oldKeyOnly,
      ),
    );
    const store = new StateAdapterTokenStore(state);

    await expect(store.get("U123", "notion")).resolves.toEqual(tokens);

    expect(await state.get("oauth-token:U123:notion")).toMatch(
      /^jenc:v1:test:/,
    );
  });
});
