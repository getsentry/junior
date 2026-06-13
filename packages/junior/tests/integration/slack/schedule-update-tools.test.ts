import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupSlackScheduleToolTest,
  createContext,
  createSlackScheduleDeleteTaskTool,
  createSlackScheduleListTasksTool,
  createSlackScheduleUpdateTaskTool,
  createTask,
  executeTool,
  schedulerStore,
  setupSlackScheduleToolTest,
  TEST_TEAM_ID,
} from "../../fixtures/slack/schedule-tools";

describe("Slack schedule update tools", () => {
  beforeEach(setupSlackScheduleToolTest);
  afterEach(cleanupSlackScheduleToolTest);

  it("edits and deletes a task from the same Slack destination", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const taskId = created.task.id;

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(context),
      {
        task_id: taskId,
        task: "Daily scheduler digest: Summarize open scheduler issues.",
        schedule: "Every day at 9am",
        recurrence: "daily",
      },
    );
    expect(updated).toMatchObject({
      ok: true,
      task: {
        id: taskId,
        task: "Daily scheduler digest: Summarize open scheduler issues.",
        schedule: "Every day at 9am",
      },
    });

    const deleted = await executeTool(
      createSlackScheduleDeleteTaskTool(context),
      {
        task_id: taskId,
      },
    );
    expect(deleted).toMatchObject({
      ok: true,
      task: {
        id: taskId,
        status: "deleted",
      },
    });

    const listed = await executeTool(
      createSlackScheduleListTasksTool(context),
      {},
    );
    expect(listed).toMatchObject({ ok: true, tasks: [] });
  });

  it("rejects edits that make a recurring task run more than once per day", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };

    await expect(
      executeTool(createSlackScheduleUpdateTaskTool(context), {
        task_id: created.task.id,
        schedule: "Every hour",
        recurrence: "hourly",
      }),
    ).rejects.toThrow(
      "Recurring scheduled tasks can run at most once per day.",
    );
    await expect(
      schedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({
      schedule: {
        description: "Every Monday at 9am",
      },
    });
  });

  it("converts recurring tasks to one-off tasks with recurrence null", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(context),
      {
        task_id: created.task.id,
        schedule: "On June 1 at 9am",
        next_run_at: "2026-06-01T16:00:00.000Z",
        recurrence: null,
      },
    );

    expect(updated).toMatchObject({
      ok: true,
      task: {
        id: created.task.id,
        next_run_at: "2026-06-01T16:00:00.000Z",
        recurrence: null,
        schedule: "On June 1 at 9am",
      },
    });
    const stored = await schedulerStore().getTask(created.task.id);
    expect(stored).toMatchObject({
      schedule: {
        kind: "one_off",
      },
    });
    expect(stored?.schedule.recurrence).toBeUndefined();
  });

  it("rejects edits from another active Slack destination", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };

    await expect(
      executeTool(
        createSlackScheduleUpdateTaskTool(createContext({ channelId: "C999" })),
        {
          task_id: created.task.id,
          task: "Wrong channel edit.",
        },
      ),
    ).rejects.toThrow(
      "Scheduled task can only be managed from the Slack destination where it was created.",
    );
  });

  it("rejects deletion from another active Slack destination", async () => {
    const created = (await createTask(
      createContext({ channelId: "DALICE" }),
    )) as { task: { id: string } };

    await expect(
      executeTool(
        createSlackScheduleDeleteTaskTool(createContext({ channelId: "DBOB" })),
        { task_id: created.task.id },
      ),
    ).rejects.toThrow(
      "Scheduled task can only be managed from the Slack destination where it was created.",
    );
  });

  it("allows another requester to manage tasks in the same Slack destination", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const otherRequester = createContext({
      requester: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        userId: "U999",
        userName: "alice",
        fullName: "Alice Reviewer",
      },
    });

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(otherRequester),
      {
        task_id: created.task.id,
        task: "Team-owned digest: Summarize open scheduler issues.",
      },
    );
    const deleted = await executeTool(
      createSlackScheduleDeleteTaskTool(otherRequester),
      {
        task_id: created.task.id,
      },
    );

    expect(updated).toMatchObject({
      ok: true,
      task: {
        id: created.task.id,
        task: "Team-owned digest: Summarize open scheduler issues.",
      },
    });
    expect(deleted).toMatchObject({
      ok: true,
      task: {
        id: created.task.id,
        status: "deleted",
      },
    });
    await expect(
      schedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({
      status: "deleted",
      executionActor: {
        type: "system",
        id: "scheduled-task",
      },
      task: {
        text: "Team-owned digest: Summarize open scheduler issues.",
      },
    });
  });

  it("preserves a recurring task calendar anchor on content-only edits", async () => {
    const context = createContext();
    const created = (await createTask(context, {
      recurrence: "weekly",
    })) as {
      task: { id: string };
    };
    const store = schedulerStore();
    const task = await store.getTask(created.task.id);
    expect(task?.schedule.recurrence).toMatchObject({
      interval: 1,
      startDate: "2026-05-25",
    });
    await store.saveTask({
      ...task!,
      nextRunAtMs: Date.parse("2026-06-08T16:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-26T16:00:00.000Z"),
    });

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(context),
      {
        task_id: created.task.id,
        task: "Renamed issue digest: Summarize open scheduler issues.",
      },
    );

    expect(updated).toMatchObject({
      ok: true,
      task: {
        task: "Renamed issue digest: Summarize open scheduler issues.",
      },
    });
    await expect(store.getTask(created.task.id)).resolves.toMatchObject({
      nextRunAtMs: Date.parse("2026-06-08T16:00:00.000Z"),
      schedule: {
        recurrence: {
          interval: 1,
          startDate: "2026-05-25",
        },
      },
    });
  });

  it("clears stale block reasons when resuming a task", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const store = schedulerStore();
    const task = await store.getTask(created.task.id);
    expect(task).toBeDefined();
    await store.saveTask({
      ...task!,
      status: "blocked",
      statusReason: "Missing GitHub credentials.",
      updatedAtMs: Date.parse("2026-05-25T16:01:00.000Z"),
    });

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(context),
      {
        task_id: created.task.id,
        status: "active",
      },
    );

    expect(updated).toMatchObject({
      ok: true,
      task: {
        id: created.task.id,
        status: "active",
      },
    });
    const resumed = await store.getTask(created.task.id);
    expect(resumed).toMatchObject({
      status: "active",
    });
    expect(resumed?.statusReason).toBeUndefined();
  });
});
