import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function setOrDelete(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("state adapter resolution decision matrix", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it.each([
    {
      label: "explicit memory adapter",
      adapter: "memory",
      redisUrl: undefined,
      expectedAdapter: "memory",
    },
    {
      label: "explicit redis adapter with URL",
      adapter: undefined,
      redisUrl: "redis://localhost:6379",
      expectedAdapter: "redis",
    },
    {
      label: "memory adapter ignores REDIS_URL",
      adapter: "memory",
      redisUrl: "redis://localhost:6379",
      expectedAdapter: "memory",
    },
    {
      label: "default adapter is redis",
      adapter: undefined,
      redisUrl: undefined,
      expectedAdapter: "redis",
    },
  ])(
    "$label (adapter=$adapter redisUrl=$redisUrl)",
    async ({ adapter, redisUrl, expectedAdapter }) => {
      setOrDelete("JUNIOR_STATE_ADAPTER", adapter);
      setOrDelete("REDIS_URL", redisUrl);
      vi.resetModules();
      const { readChatConfig } = await import("@/chat/config");
      expect(readChatConfig(process.env).state.adapter).toBe(expectedAdapter);
    },
  );
});
