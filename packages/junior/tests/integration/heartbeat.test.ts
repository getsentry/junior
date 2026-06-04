import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { GET as heartbeat } from "@/handlers/heartbeat";
import {
  heartbeatRequest,
  resetHeartbeatTestEnv,
  setupHeartbeatTestEnv,
  TEST_NOW_MS,
} from "../fixtures/heartbeat";
import { createWaitUntilCollector } from "../fixtures/wait-until";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

describe("trusted plugin heartbeat route", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    await setupHeartbeatTestEnv();
  });

  afterEach(async () => {
    await resetHeartbeatTestEnv(originalFetch);
  });

  it("rejects unauthenticated heartbeat requests", async () => {
    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat"),
      waitUntil.fn,
    );

    expect(response.status).toBe(401);
    expect(waitUntil.pendingCount()).toBe(0);
  });

  it("runs trusted plugin heartbeat hooks", async () => {
    const seen: number[] = [];
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "scheduler",
          displayName: "Scheduler",
          description: "Scheduler test plugin",
        },
        hooks: {
          heartbeat(ctx) {
            seen.push(ctx.nowMs);
          },
        },
      }),
    ]);
    const waitUntil = createWaitUntilCollector();
    const response = await heartbeat(heartbeatRequest(), waitUntil.fn);

    expect(response.status).toBe(202);
    await waitUntil.flush();
    expect(seen).toEqual([TEST_NOW_MS]);
  });
});
