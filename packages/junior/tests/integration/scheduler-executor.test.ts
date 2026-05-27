import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  executeScheduledRun,
  processDueScheduledRuns,
  type ScheduledTaskRunner,
} from "@/chat/scheduler/executor";
import {
  createStateSchedulerStore,
  type SchedulerStore,
} from "@/chat/scheduler/store";
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

async function claimDueRun(
  store: SchedulerStore,
  nowMs = Date.parse("2026-03-02T17:00:00.000Z"),
) {
  const run = await store.claimDueRun({ nowMs });
  expect(run).toBeDefined();
  return run!;
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

  it("executes a run-now request without shifting the recurring schedule", async () => {
    const store = createStateSchedulerStore();
    const scheduledNextRunAtMs = Date.parse("2026-03-09T16:00:00.000Z");
    const runNowAtMs = Date.parse("2026-03-04T18:00:00.000Z");
    const task = createTask({
      id: `sched_run_now_${Date.now()}`,
      nextRunAtMs: scheduledNextRunAtMs,
      runNowAtMs,
    });
    await store.saveTask(task);

    const completed = await processDueScheduledRuns({
      store,
      nowMs: Date.parse("2026-03-04T18:00:01.000Z"),
      limit: 10,
      runner: {
        run: async () => ({ status: "completed" }),
      },
    });

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      taskId: task.id,
      scheduledForMs: runNowAtMs,
      status: "completed",
    });
    const updated = await store.getTask(task.id);
    expect(updated).toMatchObject({
      status: "active",
      lastRunAtMs: runNowAtMs,
      nextRunAtMs: scheduledNextRunAtMs,
    });
    expect(updated?.runNowAtMs).toBeUndefined();
  });

  it("coalesces run-now with an overdue scheduled occurrence", async () => {
    const store = createStateSchedulerStore();
    const scheduledNextRunAtMs = Date.parse("2026-03-02T17:00:00.000Z");
    const runNowAtMs = Date.parse("2026-03-04T18:00:00.000Z");
    const task = createTask({
      id: `sched_run_now_overdue_${Date.now()}`,
      nextRunAtMs: scheduledNextRunAtMs,
      runNowAtMs,
    });
    await store.saveTask(task);

    const completed = await processDueScheduledRuns({
      store,
      nowMs: Date.parse("2026-03-04T18:00:01.000Z"),
      limit: 10,
      runner: {
        run: async () => ({ status: "completed" }),
      },
    });

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      taskId: task.id,
      scheduledForMs: runNowAtMs,
      status: "completed",
    });
    const updated = await store.getTask(task.id);
    expect(updated).toMatchObject({
      status: "active",
      lastRunAtMs: runNowAtMs,
      nextRunAtMs: Date.parse("2026-03-09T16:00:00.000Z"),
    });
    expect(updated?.runNowAtMs).toBeUndefined();
  });

  it("skips a stale one-off occurrence instead of dispatching it", async () => {
    const store = createStateSchedulerStore();
    const scheduledForMs = Date.parse("2026-03-02T17:00:00.000Z");
    const task = createTask({
      id: `sched_stale_one_off_${Date.now()}`,
      nextRunAtMs: scheduledForMs,
      schedule: {
        description: "Once on March 2 at 9am Pacific",
        timezone: "America/Los_Angeles",
        kind: "one_off",
      },
    });
    await store.saveTask(task);
    const runner = vi.fn<ScheduledTaskRunner["run"]>(async () => {
      throw new Error("stale one-off should not dispatch");
    });

    const completed = await processDueScheduledRuns({
      store,
      nowMs: scheduledForMs + 24 * 60 * 60 * 1000 + 1,
      limit: 10,
      runner: { run: runner },
    });

    expect(completed).toHaveLength(0);
    expect(runner).not.toHaveBeenCalled();
    await expect(
      store.getRun(`${task.id}:${scheduledForMs}`),
    ).resolves.toMatchObject({
      status: "skipped",
      scheduledForMs,
      errorMessage: expect.stringContaining("more than 24 hours late"),
    });
    const updated = await store.getTask(task.id);
    expect(updated).toMatchObject({
      status: "paused",
      nextRunAtMs: undefined,
      statusReason: expect.stringContaining("more than 24 hours late"),
      version: 2,
    });
    expect(updated?.lastRunAtMs).toBeUndefined();
  });

  it("skips stale recurring occurrences and advances to the next future run", async () => {
    const store = createStateSchedulerStore();
    const scheduledForMs = Date.parse("2026-03-02T17:00:00.000Z");
    const task = createTask({
      id: `sched_stale_recurring_${Date.now()}`,
      nextRunAtMs: scheduledForMs,
    });
    await store.saveTask(task);
    const runner = vi.fn<ScheduledTaskRunner["run"]>(async () => {
      throw new Error("stale recurring occurrence should not dispatch");
    });

    const completed = await processDueScheduledRuns({
      store,
      nowMs: Date.parse("2026-03-10T18:00:00.000Z"),
      limit: 10,
      runner: { run: runner },
    });

    expect(completed).toHaveLength(0);
    expect(runner).not.toHaveBeenCalled();
    await expect(
      store.getRun(`${task.id}:${scheduledForMs}`),
    ).resolves.toMatchObject({
      status: "skipped",
      scheduledForMs,
    });
    const updated = await store.getTask(task.id);
    expect(updated).toMatchObject({
      status: "active",
      nextRunAtMs: Date.parse("2026-03-16T16:00:00.000Z"),
      statusReason: undefined,
      version: 2,
    });
    expect(updated?.lastRunAtMs).toBeUndefined();
  });

  it("dedupes equivalent stale recurring tasks during recovery", async () => {
    const store = createStateSchedulerStore();
    const scheduledForMs = Date.parse("2026-03-02T17:00:00.000Z");
    const canonical = createTask({
      id: "sched_stale_duplicate_a",
      createdAtMs: Date.parse("2026-03-01T17:00:00.000Z"),
      nextRunAtMs: scheduledForMs,
    });
    const duplicate = createTask({
      ...canonical,
      id: "sched_stale_duplicate_b",
      createdAtMs: Date.parse("2026-03-01T17:00:01.000Z"),
      updatedAtMs: Date.parse("2026-03-01T17:00:01.000Z"),
      nextRunAtMs: scheduledForMs,
    });
    await store.saveTask(canonical);
    await store.saveTask(duplicate);
    const runner = vi.fn<ScheduledTaskRunner["run"]>(async () => {
      throw new Error("stale duplicates should not dispatch");
    });

    const completed = await processDueScheduledRuns({
      store,
      nowMs: Date.parse("2026-03-10T18:00:00.000Z"),
      limit: 10,
      runner: { run: runner },
    });

    expect(completed).toHaveLength(0);
    expect(runner).not.toHaveBeenCalled();
    await expect(
      store.getRun(`${canonical.id}:${scheduledForMs}`),
    ).resolves.toMatchObject({
      status: "skipped",
      scheduledForMs,
    });
    await expect(
      store.getRun(`${duplicate.id}:${scheduledForMs}`),
    ).resolves.toMatchObject({
      status: "skipped",
      scheduledForMs,
      errorMessage: expect.stringContaining(canonical.id),
    });
    await expect(store.getTask(canonical.id)).resolves.toMatchObject({
      status: "active",
      nextRunAtMs: Date.parse("2026-03-16T16:00:00.000Z"),
      statusReason: undefined,
    });
    await expect(store.getTask(duplicate.id)).resolves.toMatchObject({
      status: "paused",
      nextRunAtMs: undefined,
      statusReason: expect.stringContaining(canonical.id),
    });
  });

  it("skips stale run-now requests without shifting the stored schedule", async () => {
    const store = createStateSchedulerStore();
    const scheduledNextRunAtMs = Date.parse("2026-03-09T16:00:00.000Z");
    const runNowAtMs = Date.parse("2026-03-04T18:00:00.000Z");
    const task = createTask({
      id: `sched_stale_run_now_${Date.now()}`,
      nextRunAtMs: scheduledNextRunAtMs,
      runNowAtMs,
    });
    await store.saveTask(task);
    const runner = vi.fn<ScheduledTaskRunner["run"]>(async () => {
      throw new Error("stale run-now should not dispatch");
    });

    const completed = await processDueScheduledRuns({
      store,
      nowMs: Date.parse("2026-03-05T18:00:01.000Z"),
      limit: 10,
      runner: { run: runner },
    });

    expect(completed).toHaveLength(0);
    expect(runner).not.toHaveBeenCalled();
    await expect(
      store.getRun(`${task.id}:${runNowAtMs}`),
    ).resolves.toMatchObject({
      status: "skipped",
      scheduledForMs: runNowAtMs,
    });
    const updated = await store.getTask(task.id);
    expect(updated).toMatchObject({
      status: "active",
      nextRunAtMs: scheduledNextRunAtMs,
      statusReason: undefined,
      version: 2,
    });
    expect(updated?.runNowAtMs).toBeUndefined();
    expect(updated?.lastRunAtMs).toBeUndefined();
  });

  it("blocks the task when the runner reports missing requirements", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_blocked_${Date.now()}` });
    await store.saveTask(task);
    const run = await claimDueRun(store);

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
    const run = await claimDueRun(store);

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

    const retryRun = await claimDueRun(
      store,
      Date.parse("2026-03-02T17:00:03.000Z"),
    );

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
    const firstRun = await claimDueRun(store);
    await store.markRunStarted({
      runId: firstRun.id,
      claimedAtMs: firstRun.claimedAtMs,
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
      store.claimDueRun({
        nowMs: Date.parse("2026-03-09T16:00:01.000Z"),
      }),
    ).resolves.toBeUndefined();

    await store.markRunCompleted({
      runId: firstRun.id,
      completedAtMs: Date.parse("2026-03-02T17:00:03.000Z"),
      startedAtMs: Date.parse("2026-03-02T17:00:01.000Z"),
    });

    const nextRun = await claimDueRun(
      store,
      Date.parse("2026-03-09T16:00:01.000Z"),
    );
    expect(nextRun).toMatchObject({
      taskId: task.id,
      scheduledForMs: editedNextRunAtMs,
      status: "pending",
    });
  });

  it("does not skip a stale occurrence while the same task is running", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_stale_overlap_${Date.now()}` });
    await store.saveTask(task);
    const firstRun = await claimDueRun(store);
    await store.markRunStarted({
      runId: firstRun.id,
      claimedAtMs: firstRun.claimedAtMs,
      nowMs: Date.parse("2026-03-02T17:00:01.000Z"),
    });
    const staleNextRunAtMs = Date.parse("2026-03-03T17:00:00.000Z");
    await store.saveTask({
      ...task,
      nextRunAtMs: staleNextRunAtMs,
      updatedAtMs: Date.parse("2026-03-02T17:00:02.000Z"),
      version: task.version + 1,
    });

    await expect(
      store.claimDueRun({
        nowMs: Date.parse("2026-03-05T17:00:01.000Z"),
      }),
    ).resolves.toBeUndefined();

    await expect(
      store.getRun(`${task.id}:${staleNextRunAtMs}`),
    ).resolves.toBeUndefined();
    await expect(store.getTask(task.id)).resolves.toMatchObject({
      status: "active",
      nextRunAtMs: staleNextRunAtMs,
      version: 2,
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

    const firstRun = await claimDueRun(store);
    const abandonedRun = await claimDueRun(store);
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

    const retryRun = await claimDueRun(
      store,
      Date.parse("2026-03-02T17:01:00.000Z"),
    );
    expect(retryRun).toMatchObject({
      id: abandonedRun.id,
      taskId: secondTask.id,
      scheduledForMs: abandonedRun.scheduledForMs,
      status: "pending",
    });
  });

  it("does not let an abandoned claim start after the run is reclaimed", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_stale_claim_${Date.now()}` });
    await store.saveTask(task);
    const abandonedRun = await claimDueRun(store);
    const reclaimedRun = await claimDueRun(
      store,
      Date.parse("2026-03-02T17:01:00.000Z"),
    );

    await expect(
      executeScheduledRun({
        store,
        run: abandonedRun,
        nowMs: Date.parse("2026-03-02T17:01:01.000Z"),
        runner: {
          run: async () => {
            throw new Error("stale claim should not start");
          },
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      executeScheduledRun({
        store,
        run: reclaimedRun,
        nowMs: Date.parse("2026-03-02T17:01:02.000Z"),
        runner: {
          run: async () => ({ status: "completed" }),
        },
      }),
    ).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("does not let a stale older claim block a retargeted due run", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_stale_retarget_${Date.now()}` });
    await store.saveTask(task);
    const abandonedRun = await claimDueRun(store);
    const retargetedNextRunAtMs = Date.parse("2026-03-02T17:00:30.000Z");
    await store.saveTask({
      ...task,
      nextRunAtMs: retargetedNextRunAtMs,
      updatedAtMs: Date.parse("2026-03-02T17:00:10.000Z"),
      version: task.version + 1,
    });

    const retargetedRun = await claimDueRun(
      store,
      Date.parse("2026-03-02T17:01:00.000Z"),
    );

    expect(retargetedRun).toMatchObject({
      id: `${task.id}:${retargetedNextRunAtMs}`,
      taskId: task.id,
      scheduledForMs: retargetedNextRunAtMs,
    });
    expect(retargetedRun.id).not.toBe(abandonedRun.id);
  });

  it("reclaims a due run when an active marker was written without a run record", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_missing_run_${Date.now()}` });
    await store.saveTask(task);
    const scheduledForMs = task.nextRunAtMs!;
    const state = getStateAdapter();
    await state.connect();
    await state.set(
      `junior:scheduler:active:${task.id}`,
      {
        claimedAtMs: Date.parse("2026-03-02T17:00:00.000Z"),
        runId: `${task.id}:${scheduledForMs}`,
        scheduledForMs,
      },
      6 * 60 * 60 * 1000,
    );

    const reclaimed = await claimDueRun(
      store,
      Date.parse("2026-03-02T17:01:00.000Z"),
    );

    expect(reclaimed).toMatchObject({
      id: `${task.id}:${scheduledForMs}`,
      taskId: task.id,
      scheduledForMs,
      status: "pending",
    });
  });

  it("does not restart a run another tick already completed", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_completed_claim_${Date.now()}` });
    await store.saveTask(task);
    const run = await claimDueRun(store);

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
    const run = await claimDueRun(store);

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

  it("skips a claimed run when the task is deleted before execution starts", async () => {
    const store = createStateSchedulerStore();
    const task = createTask({ id: `sched_deleted_before_start_${Date.now()}` });
    await store.saveTask(task);
    const run = await claimDueRun(store);
    await store.saveTask({
      ...task,
      status: "deleted",
      nextRunAtMs: undefined,
      updatedAtMs: Date.parse("2026-03-02T17:00:00.500Z"),
      version: task.version + 1,
    });

    await expect(
      executeScheduledRun({
        store,
        run,
        nowMs: Date.parse("2026-03-02T17:00:01.000Z"),
        runner: {
          run: async () => {
            throw new Error("deleted task should not execute");
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "skipped",
      errorMessage: expect.stringContaining(
        "was deleted before the run started",
      ),
    });
  });
});
