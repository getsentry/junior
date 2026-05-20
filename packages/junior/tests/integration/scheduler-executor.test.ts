import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  executeScheduledRun,
  processDueScheduledRuns,
  type ScheduledTaskRunner,
} from "@/chat/scheduler/executor";
import { createStateSchedulerStore } from "@/chat/scheduler/store";
import type { ScheduledTask } from "@/chat/scheduler/types";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const firstRunAtMs = Date.parse("2026-03-02T17:00:00.000Z");
  return {
    id: `sched_executor_${Date.now()}`,
    createdAtMs: firstRunAtMs,
    updatedAtMs: firstRunAtMs,
    createdBy: {
      slackUserId: "U123",
      userName: "dcramer",
      fullName: "David Cramer",
    },
    destination: {
      platform: "slack",
      teamId: "T_EXECUTOR",
      channelId: "C123",
      threadTs: "1700000000.000000",
    },
    nextRunAtMs: firstRunAtMs,
    schedule: {
      description: "Every Monday at 9am Pacific",
      timezone: "America/Los_Angeles",
      kind: "recurring",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        startDate: "2026-03-02",
        time: {
          hour: 9,
          minute: 0,
        },
        weekdays: [1],
      },
    },
    status: "active",
    task: {
      title: "Issue digest",
      objective: "Summarize scheduler issues.",
      instructions: ["Find open scheduler issues", "Post a concise digest"],
    },
    version: 1,
    ...overrides,
  };
}

describe("scheduler executor", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("wraps claimed tasks in the scheduled-run prompt and advances recurrence", async () => {
    const store = createStateSchedulerStore();
    const task = createTask();
    await store.saveTask(task);
    const prompts: string[] = [];
    const runner: ScheduledTaskRunner = {
      run: async ({ prompt }) => {
        prompts.push(prompt);
        return { status: "completed", resultMessageTs: "1700000000.000001" };
      },
    };

    const completed = await processDueScheduledRuns({
      store,
      runner,
      nowMs: Date.parse("2026-03-02T17:00:04.500Z"),
      limit: 10,
    });

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      taskId: task.id,
      status: "completed",
      scheduledForMs: Date.parse("2026-03-02T17:00:00.000Z"),
    });
    expect(prompts[0]).toContain("<scheduled-task-run>");
    expect(prompts[0]).toContain(
      "Execute the scheduled task now and provide the final result",
    );

    const updated = await store.getTask(task.id);
    expect(updated).toMatchObject({
      status: "active",
      lastRunAtMs: Date.parse("2026-03-02T17:00:00.000Z"),
      nextRunAtMs: Date.parse("2026-03-09T16:00:00.000Z"),
      version: 2,
    });
  });

  it("keeps monthly recurrence on the exact calendar date", async () => {
    const store = createStateSchedulerStore();
    const firstRunAtMs = Date.parse("2026-01-31T09:00:00.000Z");
    const task = createTask({
      id: `sched_monthly_${Date.now()}`,
      nextRunAtMs: firstRunAtMs,
      schedule: {
        description: "Every month on the 31st at 9am UTC",
        timezone: "UTC",
        kind: "recurring",
        recurrence: {
          frequency: "monthly",
          interval: 1,
          startDate: "2026-01-31",
          time: {
            hour: 9,
            minute: 0,
          },
          dayOfMonth: 31,
        },
      },
    });
    await store.saveTask(task);

    await processDueScheduledRuns({
      store,
      nowMs: Date.parse("2026-02-01T00:00:00.000Z"),
      limit: 10,
      runner: {
        run: async () => ({ status: "completed" }),
      },
    });

    const updated = await store.getTask(task.id);
    expect(updated).toMatchObject({
      lastRunAtMs: firstRunAtMs,
      nextRunAtMs: Date.parse("2026-03-31T09:00:00.000Z"),
    });
  });

  it("blocks the task when the runner reports missing requirements", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_blocked_${Date.now()}` });
    await store.saveTask(task);
    const [run] = await store.claimDueRuns({
      nowMs: Date.parse("2026-03-02T17:00:00.000Z"),
      limit: 10,
    });

    const completed = await executeScheduledRun({
      store,
      run,
      nowMs: Date.parse("2026-03-02T17:00:01.500Z"),
      runner: {
        run: async () => ({
          status: "blocked",
          errorMessage: "Missing GitHub credentials.",
        }),
      },
    });

    expect(completed).toMatchObject({
      status: "blocked",
      errorMessage: "Missing GitHub credentials.",
    });
    const updated = await store.getTask(task.id);
    expect(updated).toMatchObject({
      status: "blocked",
      statusReason: "Missing GitHub credentials.",
      nextRunAtMs: undefined,
    });
  });

  it("allows a resumed blocked task to retry the same due instant", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_blocked_retry_${Date.now()}` });
    await store.saveTask(task);
    const [run] = await store.claimDueRuns({
      nowMs: Date.parse("2026-03-02T17:00:00.000Z"),
      limit: 10,
    });

    await executeScheduledRun({
      store,
      run,
      nowMs: Date.parse("2026-03-02T17:00:01.500Z"),
      runner: {
        run: async () => ({
          status: "blocked",
          errorMessage: "Missing GitHub credentials.",
        }),
      },
    });

    const blocked = await store.getTask(task.id);
    expect(blocked).toMatchObject({
      status: "blocked",
      nextRunAtMs: undefined,
    });
    await store.saveTask({
      ...blocked!,
      nextRunAtMs: run.scheduledForMs,
      status: "active",
      statusReason: undefined,
      updatedAtMs: Date.parse("2026-03-02T17:00:02.000Z"),
      version: blocked!.version + 1,
    });

    const [retryRun] = await store.claimDueRuns({
      nowMs: Date.parse("2026-03-02T17:00:03.000Z"),
      limit: 10,
    });

    expect(retryRun).toMatchObject({
      id: run.id,
      taskId: task.id,
      scheduledForMs: run.scheduledForMs,
      status: "pending",
    });
  });

  it("does not claim another due run while the same task is running", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_overlap_${Date.now()}` });
    await store.saveTask(task);
    const [firstRun] = await store.claimDueRuns({
      nowMs: Date.parse("2026-03-02T17:00:00.000Z"),
      limit: 10,
    });
    await store.markRunStarted({
      runId: firstRun.id,
      nowMs: Date.parse("2026-03-02T17:00:01.000Z"),
    });
    const editedNextRunAtMs = Date.parse("2026-03-09T16:00:00.000Z");
    await store.saveTask({
      ...task,
      nextRunAtMs: editedNextRunAtMs,
      updatedAtMs: Date.parse("2026-03-02T17:00:02.000Z"),
      version: task.version + 1,
    });

    await expect(
      store.claimDueRuns({
        nowMs: Date.parse("2026-03-09T16:00:01.000Z"),
        limit: 10,
      }),
    ).resolves.toHaveLength(0);

    await store.markRunCompleted({
      runId: firstRun.id,
      completedAtMs: Date.parse("2026-03-02T17:00:03.000Z"),
    });

    const [nextRun] = await store.claimDueRuns({
      nowMs: Date.parse("2026-03-09T16:00:01.000Z"),
      limit: 10,
    });
    expect(nextRun).toMatchObject({
      taskId: task.id,
      scheduledForMs: editedNextRunAtMs,
      status: "pending",
    });
  });

  it("reclaims due tasks left pending by an aborted tick", async () => {
    const store = createStateSchedulerStore();
    const firstTask = createTask({ id: `sched_aborted_first_${Date.now()}` });
    const secondTask = createTask({
      id: `sched_aborted_second_${Date.now()}`,
    });
    await store.saveTask(firstTask);
    await store.saveTask(secondTask);

    const [firstRun, abandonedRun] = await store.claimDueRuns({
      nowMs: Date.parse("2026-03-02T17:00:00.000Z"),
      limit: 10,
    });
    expect(firstRun).toMatchObject({ taskId: firstTask.id });
    expect(abandonedRun).toMatchObject({
      taskId: secondTask.id,
      status: "pending",
    });

    await executeScheduledRun({
      store,
      run: firstRun,
      nowMs: Date.parse("2026-03-02T17:00:01.000Z"),
      runner: {
        run: async () => ({ status: "completed" }),
      },
    });

    const [retryRun] = await store.claimDueRuns({
      nowMs: Date.parse("2026-03-02T17:01:00.000Z"),
      limit: 10,
    });
    expect(retryRun).toMatchObject({
      id: abandonedRun.id,
      taskId: secondTask.id,
      scheduledForMs: abandonedRun.scheduledForMs,
      status: "pending",
    });
  });

  it("does not restart a run another tick already completed", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_completed_claim_${Date.now()}` });
    await store.saveTask(task);
    const [run] = await store.claimDueRuns({
      nowMs: Date.parse("2026-03-02T17:00:00.000Z"),
      limit: 10,
    });

    await executeScheduledRun({
      store,
      run,
      nowMs: Date.parse("2026-03-02T17:00:01.000Z"),
      runner: {
        run: async () => ({ status: "completed" }),
      },
    });

    await expect(
      executeScheduledRun({
        store,
        run,
        nowMs: Date.parse("2026-03-02T17:00:02.000Z"),
        runner: {
          run: async () => {
            throw new Error("completed run should not restart");
          },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("does not resurrect a task deleted while a run is executing", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_deleted_${Date.now()}` });
    await store.saveTask(task);
    const [run] = await store.claimDueRuns({
      nowMs: Date.parse("2026-03-02T17:00:00.000Z"),
      limit: 10,
    });

    await executeScheduledRun({
      store,
      run,
      nowMs: Date.parse("2026-03-02T17:00:01.500Z"),
      runner: {
        run: async () => {
          await store.saveTask({
            ...task,
            status: "deleted",
            nextRunAtMs: undefined,
            updatedAtMs: Date.parse("2026-03-02T17:00:01.000Z"),
            version: task.version + 1,
          });
          return { status: "completed" };
        },
      },
    });

    const updated = await store.getTask(task.id);
    expect(updated).toMatchObject({
      status: "deleted",
      nextRunAtMs: undefined,
      version: 2,
    });
  });
});
