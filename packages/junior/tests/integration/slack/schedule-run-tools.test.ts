import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupSlackScheduleToolTest,
  createContext,
  createSlackScheduleDeleteTaskTool,
  createSlackScheduleRunTaskNowTool,
  createTask,
  executeTool,
  schedulerStore,
  setupSlackScheduleToolTest,
  TEST_TEAM_ID,
} from "../../fixtures/slack/schedule-tools";

describe("Slack schedule run tools", () => {
  beforeEach(setupSlackScheduleToolTest);
  afterEach(cleanupSlackScheduleToolTest);

  it("marks an active task due immediately without changing its scheduled next run", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const store = schedulerStore();
    const task = await store.getTask(created.task.id);
    expect(task).toBeDefined();
    const scheduledNextRunAtMs = Date.parse("2026-06-01T16:00:00.000Z");
    await store.saveTask({
      ...task!,
      nextRunAtMs: scheduledNextRunAtMs,
      updatedAtMs: Date.parse("2026-05-25T16:01:00.000Z"),
    });

    const beforeMs = Date.now();
    const result = await executeTool(
      createSlackScheduleRunTaskNowTool(context),
      {
        task_id: created.task.id,
      },
    );
    const afterMs = Date.now();

    expect(result).toMatchObject({
      ok: true,
      task: {
        id: created.task.id,
        status: "active",
        next_run_at: "2026-06-01T16:00:00.000Z",
      },
    });
    const due = await store.getTask(created.task.id);
    expect(due).toMatchObject({
      status: "active",
      nextRunAtMs: scheduledNextRunAtMs,
      destination: {
        teamId: context.source?.teamId,
        channelId: context.source?.channelId,
      },
      createdBy: {
        slackUserId: context.requester?.userId,
      },
    });
    expect(due?.statusReason).toBeUndefined();
    expect(due?.runNowAtMs).toBeGreaterThanOrEqual(beforeMs);
    expect(due?.runNowAtMs).toBeLessThanOrEqual(afterMs);

    await expect(store.claimDueRun({ nowMs: afterMs })).resolves.toMatchObject({
      taskId: created.task.id,
      scheduledForMs: due?.runNowAtMs,
      status: "pending",
    });
  });

  it("does not run-now a paused task without an explicit resume", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const store = schedulerStore();
    const task = await store.getTask(created.task.id);
    expect(task).toBeDefined();
    await store.saveTask({
      ...task!,
      status: "paused",
      statusReason: "Paused by user.",
      updatedAtMs: Date.parse("2026-05-25T16:01:00.000Z"),
    });

    await expect(
      executeTool(createSlackScheduleRunTaskNowTool(context), {
        task_id: created.task.id,
      }),
    ).rejects.toThrow(
      "Scheduled task must be active before it can be run now. Resume the task first if you want it to run.",
    );
    const paused = await store.getTask(created.task.id);
    expect(paused).toMatchObject({
      status: "paused",
      statusReason: "Paused by user.",
    });
    expect(paused?.runNowAtMs).toBeUndefined();
  });

  it("removes deleted tasks from scheduler listings", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };

    await executeTool(createSlackScheduleDeleteTaskTool(context), {
      task_id: created.task.id,
    });

    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("claims due runs idempotently", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const store = schedulerStore();
    const task = await store.getTask(created.task.id);
    expect(task).toBeDefined();
    await store.saveTask({
      ...task!,
      nextRunAtMs: 1000,
      updatedAtMs: 1000,
    });

    const first = await store.claimDueRun({ nowMs: 2000 });
    const second = await store.claimDueRun({ nowMs: 2000 });

    expect(first).toMatchObject({
      taskId: created.task.id,
      scheduledForMs: 1000,
      status: "pending",
    });
    expect(second).toBeUndefined();
  });
});
