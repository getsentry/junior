import * as vitest from "vitest";
import { getGlobalDispatcher } from "undici";

const { expect, it, vi } = vitest;

it("installs the worker dispatcher and restores it after the suite", async () => {
  const teardown: Array<() => Promise<void>> = [];
  // Keep real test APIs while replacing only invocation context and lifecycle hooks.
  vi.doMock("vitest", () => ({
    ...vitest,
    inject: () => ({
      baseUrl: "https://eval.example.test",
      stateKeyPrefix: "eval-setup:",
      redisUrl: "redis://127.0.0.1:6382",
    }),
    beforeEach: () => {},
    afterEach: () => {},
    afterAll: (hook: () => Promise<void>) => teardown.push(hook),
  }));
  const previous = getGlobalDispatcher();
  const keys = [
    "JUNIOR_BASE_URL",
    "JUNIOR_STATE_ADAPTER",
    "JUNIOR_STATE_KEY_PREFIX",
    "REDIS_URL",
  ];
  const env = keys.map((key) => [key, process.env[key]] as const);
  try {
    await import("../../src/setup");
    expect(getGlobalDispatcher()).not.toBe(previous);
    expect(teardown).toHaveLength(1);
  } finally {
    vi.doUnmock("vitest");
    for (const hook of teardown) await hook();
    for (const [key, value] of env) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  expect(getGlobalDispatcher()).toBe(previous);
});
