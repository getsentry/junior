import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createHeartbeatContext } from "@/chat/agent-dispatch/context";
import { recoverStaleDispatches } from "@/chat/agent-dispatch/heartbeat";
import {
  createOrGetDispatch,
  getDispatchRecord,
  getDispatchStorageKey,
  updateDispatchRecord,
  withDispatchLock,
} from "@/chat/agent-dispatch/store";
import type { DispatchRecord } from "@/chat/agent-dispatch/types";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { setAgentPlugins } from "@/chat/plugins/agent-hooks";
import { GET as heartbeat } from "@/handlers/heartbeat";
import type { WaitUntilFn } from "@/handlers/types";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

function collectWaitUntil(tasks: Promise<unknown>[]): WaitUntilFn {
  return (task) => {
    tasks.push(typeof task === "function" ? task() : task);
  };
}

describe("trusted plugin heartbeat", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    process.env.JUNIOR_SCHEDULER_SECRET = "heartbeat-secret";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    process.env.JUNIOR_SECRET = "dispatch-secret";
    setAgentPlugins([]);
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    setAgentPlugins([]);
    await disconnectStateAdapter();
    delete process.env.JUNIOR_SCHEDULER_SECRET;
    delete process.env.CRON_SECRET;
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_SECRET;
    vi.restoreAllMocks();
  });

  it("rejects unauthenticated heartbeat requests", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    const response = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat"),
      collectWaitUntil(waitUntilTasks),
    );

    expect(response.status).toBe(401);
    expect(waitUntilTasks).toHaveLength(0);
  });

  it("runs trusted plugin heartbeat hooks", async () => {
    const seen: number[] = [];
    setAgentPlugins([
      defineJuniorPlugin({
        name: "scheduler",
        hooks: {
          heartbeat(ctx) {
            seen.push(ctx.nowMs);
          },
        },
      }),
    ]);
    const waitUntilTasks: Promise<unknown>[] = [];
    const response = await heartbeat(
      new Request("https://example.invalid/api/internal/heartbeat", {
        headers: { authorization: "Bearer heartbeat-secret" },
      }),
      collectWaitUntil(waitUntilTasks),
    );

    expect(response.status).toBe(202);
    await Promise.all(waitUntilTasks);
    expect(seen).toHaveLength(1);
  });

  it("scopes dispatch lookup to the plugin that created it", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    const schedulerCtx = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });
    const result = await schedulerCtx.agent.dispatch({
      idempotencyKey: "run-1",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
      },
      input: "Run the scheduled task.",
      metadata: { runId: "run-1" },
    });

    await expect(schedulerCtx.agent.get(result.id)).resolves.toEqual({
      id: result.id,
      status: "pending",
    });
    await expect(
      createHeartbeatContext({
        plugin: "other-plugin",
        nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      }).agent.get(result.id),
    ).resolves.toBeUndefined();

    await expect(getDispatchRecord(result.id)).resolves.toMatchObject({
      input: "Run the scheduled task.",
      destination: { channelId: "C123" },
      metadata: { runId: "run-1" },
    });
  });

  it("keeps plugin state isolated when plugin names and keys contain delimiters", async () => {
    const first = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });
    const second = createHeartbeatContext({
      plugin: "scheduler:run",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    await first.state.set("run:1", "first");
    await second.state.set("1", "second");

    await expect(first.state.get("run:1")).resolves.toBe("first");
    await expect(second.state.get("1")).resolves.toBe("second");
  });

  it("bounds dispatch fanout from one heartbeat context", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Accepted", { status: 202 });
    });
    global.fetch = fetchMock as typeof fetch;

    const ctx = createHeartbeatContext({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
    });

    for (let index = 0; index < 25; index += 1) {
      await ctx.agent.dispatch({
        idempotencyKey: `run-${index}`,
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
      });
    }

    await expect(
      ctx.agent.dispatch({
        idempotencyKey: "run-over-limit",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
      }),
    ).rejects.toThrow("Plugin heartbeat exceeded the dispatch limit");
  });

  it("fails stale dispatches that exceed retry attempts", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-exhausted",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
      },
    });
    await withDispatchLock(created.record.id, async (state) => {
      const record = await state.get<DispatchRecord>(
        getDispatchStorageKey(created.record.id),
      );
      if (!record) {
        throw new Error("Expected dispatch record to exist");
      }
      await updateDispatchRecord(state, {
        ...record,
        attempt: record.maxAttempts,
        lastCallbackAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      });
    });

    await expect(
      recoverStaleDispatches({
        nowMs: Date.parse("2026-05-26T12:05:00.000Z"),
      }),
    ).resolves.toBe(0);
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "Dispatch exceeded retry attempts.",
    });
  });
});
