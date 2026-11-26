import { afterEach, beforeEach, inject, vi } from "vitest";
import "./eval-context";

// The product waits 30 seconds after a watched event for more events. An
// eval sends its events as one batch, so the wait only adds time.
// `event-wake-delay.test.ts` in `packages/junior` covers the wait.
vi.mock("@/chat/events/notification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/events/notification")>()),
  EVENT_WAIT_MS: 0,
}));

const context = inject("juniorEvalContext");
if (!context) {
  throw new Error("Eval global setup did not provide invocation context");
}
const evalContext = context;
process.env["JUNIOR_BASE_URL"] = evalContext.baseUrl;
process.env["JUNIOR_STATE_ADAPTER"] = "redis";
process.env["JUNIOR_STATE_KEY_PREFIX"] = evalContext.stateKeyPrefix;
process.env["REDIS_URL"] = evalContext.redisUrl;

beforeEach(async () => {
  // `stable-setup.ts` set the eval clock of this test. The main process uses
  // the same time when it checks sandbox egress tokens and leases.
  const response = await fetch(evalContext.controlUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${evalContext.controlToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ nowMs: Date.now() }),
  });
  if (!response.ok) {
    throw new Error(
      `Eval egress fixture reset failed with HTTP ${response.status}`,
    );
  }
});

beforeEach(async () => {
  // Redis outlives the Postgres reset of each test. A cached email would
  // point the viewer at a User of an earlier test, which no longer exists,
  // so delete every key of the user cache. Do not flush Redis: tests share
  // the cached Sandbox snapshots in it.
  const [{ getConnectedStateContext, redisStateKey }, cache, users] =
    await Promise.all([
      import("@/chat/state/adapter"),
      import("@/chat/state/cache"),
      import("@/chat/identities/user-cache"),
    ]);
  const { redisStateAdapter } = await getConnectedStateContext();
  if (!redisStateAdapter) throw new Error("Evals need the Redis state adapter");
  const redis = redisStateAdapter.getClient();
  const prefix = redisStateKey(
    cache.cacheKeyPrefix(users.USER_CACHE_NAMESPACE),
  );
  for await (const keys of redis.scanIterator({ MATCH: `${prefix}*` })) {
    if (keys.length > 0) await redis.del(keys);
  }
});

afterEach(async () => {
  // Keep stateful runtime modules behind the invocation-provided Redis env.
  const { closeDb } = await import("@/chat/db");
  await closeDb();
});
