import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { ALL as schedulerTick } from "@/handlers/scheduler-tick";
import type { WaitUntilFn } from "@/handlers/types";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

function collectWaitUntil(tasks: Promise<unknown>[]): WaitUntilFn {
  return (task) => {
    tasks.push(typeof task === "function" ? task() : task);
  };
}

describe("scheduler tick handler", () => {
  beforeEach(async () => {
    process.env.JUNIOR_SCHEDULER_SECRET = "test-secret";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    delete process.env.JUNIOR_SCHEDULER_SECRET;
    delete process.env.CRON_SECRET;
    delete process.env.JUNIOR_INTERNAL_RESUME_SECRET;
  });

  it("rejects unauthenticated scheduler ticks", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    const response = await schedulerTick(
      new Request("https://example.invalid/api/internal/scheduler/tick"),
      collectWaitUntil(waitUntilTasks),
    );

    expect(response.status).toBe(401);
    expect(waitUntilTasks).toHaveLength(0);
  });

  it("accepts bearer-authenticated scheduler ticks", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    const response = await schedulerTick(
      new Request("https://example.invalid/api/internal/scheduler/tick", {
        headers: {
          authorization: "Bearer test-secret",
        },
      }),
      collectWaitUntil(waitUntilTasks),
    );

    expect(response.status).toBe(202);
    await Promise.all(waitUntilTasks);
    expect(waitUntilTasks).toHaveLength(1);
  });

  it("accepts cron bearer authentication", async () => {
    delete process.env.JUNIOR_SCHEDULER_SECRET;
    process.env.CRON_SECRET = "cron-secret";
    const waitUntilTasks: Promise<unknown>[] = [];
    const response = await schedulerTick(
      new Request("https://example.invalid/api/internal/scheduler/tick", {
        headers: {
          authorization: "Bearer cron-secret",
        },
      }),
      collectWaitUntil(waitUntilTasks),
    );

    expect(response.status).toBe(202);
    await Promise.all(waitUntilTasks);
    expect(waitUntilTasks).toHaveLength(1);
  });

  it("does not accept the timeout resume secret for scheduler ticks", async () => {
    delete process.env.JUNIOR_SCHEDULER_SECRET;
    process.env.JUNIOR_INTERNAL_RESUME_SECRET = "resume-secret";
    const waitUntilTasks: Promise<unknown>[] = [];
    const response = await schedulerTick(
      new Request("https://example.invalid/api/internal/scheduler/tick", {
        headers: {
          authorization: "Bearer resume-secret",
        },
      }),
      collectWaitUntil(waitUntilTasks),
    );

    expect(response.status).toBe(401);
    expect(waitUntilTasks).toHaveLength(0);
  });
});
