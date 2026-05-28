import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createStateSchedulerStore } from "@/chat/scheduler/store";
import {
  createSlackScheduleCreateTaskTool,
  createSlackScheduleDeleteTaskTool,
  createSlackScheduleListTasksTool,
  createSlackScheduleRunTaskNowTool,
  createSlackScheduleUpdateTaskTool,
} from "@/chat/tools/slack/schedule-tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

const TEST_TEAM_ID = `TSCHEDULE${Date.now()}`;

function createContext(
  overrides: Partial<ToolRuntimeContext> = {},
): ToolRuntimeContext {
  return {
    channelId: "C123",
    teamId: TEST_TEAM_ID,
    requester: {
      userId: "U123",
      userName: "dcramer",
      fullName: "David Cramer",
    },
    channelCapabilities: {
      canCreateCanvas: true,
      canPostToChannel: true,
      canAddReactions: true,
    },
    userText: "schedule this weekly",
    sandbox: {} as ToolRuntimeContext["sandbox"],
    ...overrides,
  };
}

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

async function createTask(
  context = createContext(),
  overrides: Record<string, unknown> = {},
) {
  const tool = createSlackScheduleCreateTaskTool(context);
  return await executeTool(tool, {
    title: "Weekly issue digest",
    objective: "Summarize open scheduler issues.",
    instructions: ["Find open scheduler issues", "Post a concise summary"],
    expected_output: "A short Slack digest",
    schedule_description: "Every Monday at 9am",
    timezone: "America/Los_Angeles",
    next_run_at_iso: "2026-05-25T16:00:00.000Z",
    recurrence_frequency: "weekly",
    recurrence_weekdays: [1],
    ...overrides,
  });
}

describe("Slack schedule tools", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.JUNIOR_TIMEZONE;
    await disconnectStateAdapter();
  });

  it("creates and lists tasks only for the active Slack destination", async () => {
    const created = await createTask();
    expect(created).toMatchObject({
      ok: true,
      task: {
        status: "active",
        title: "Weekly issue digest",
        recurrence: {
          frequency: "weekly",
          interval: 1,
          weekdays: [1],
        },
        next_run_at: "2026-05-25T16:00:00.000Z",
      },
    });

    const listed = await executeTool(
      createSlackScheduleListTasksTool(createContext()),
      {},
    );
    expect(listed).toMatchObject({
      ok: true,
      tasks: [
        {
          title: "Weekly issue digest",
          schedule: "Every Monday at 9am",
        },
      ],
    });

    const sameChannelOtherThread = await executeTool(
      createSlackScheduleListTasksTool(
        createContext({ threadTs: "1700000999.000000" }),
      ),
      {},
    );
    expect(sameChannelOtherThread).toMatchObject({
      ok: true,
      tasks: [
        {
          title: "Weekly issue digest",
          schedule: "Every Monday at 9am",
        },
      ],
    });
  });

  it("creates clear recurring tasks without a second confirmation", async () => {
    const result = await executeTool(
      createSlackScheduleCreateTaskTool(createContext()),
      {
        title: "Weekly issue digest",
        objective: "Summarize open scheduler issues.",
        instructions: ["Find open scheduler issues", "Post a concise summary"],
        schedule_description: "Every Monday at 9am",
        timezone: "America/Los_Angeles",
        next_run_at_iso: "2026-05-25T16:00:00.000Z",
        recurrence_frequency: "weekly",
        recurrence_weekdays: [1],
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        schedule: "Every Monday at 9am",
        status: "active",
        title: "Weekly issue digest",
      },
    });
    await expect(
      createStateSchedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        destination: { channelId: "C123" },
        status: "active",
      },
    ]);
  });

  it("rejects invalid Slack workspace context before creating a task", async () => {
    const result = await executeTool(
      createSlackScheduleCreateTaskTool(createContext({ teamId: "D123" })),
      {
        title: "Reminder",
        objective: "Remind David to wash his hands.",
        instructions: ["Remind David to wash his hands."],
        schedule_description: "In 1 minute",
        next_run_at_text: "in 1 minute",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Active Slack workspace context is invalid.",
    });
    await expect(
      createStateSchedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("creates explicit one-off reminders without a second confirmation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:24:23.000Z"));

    const result = await executeTool(
      createSlackScheduleCreateTaskTool(
        createContext({
          channelId: "D123",
          userText: "remind me in 1 minute to wash my hands",
        }),
      ),
      {
        title: "Wash hands reminder",
        objective: "Remind David to wash his hands.",
        instructions: ["Remind David to wash his hands."],
        schedule_description: "In 1 minute",
        next_run_at_text: "in 1 minute",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-27T00:25:23.000Z",
        schedule: "In 1 minute",
        status: "active",
        title: "Wash hands reminder",
      },
    });
    await expect(
      createStateSchedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        destination: { channelId: "D123" },
        nextRunAtMs: Date.parse("2026-05-27T00:25:23.000Z"),
        status: "active",
      },
    ]);
  });

  it("creates short imperative one-off reminders without channel confirmation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:24:23.000Z"));

    const result = await executeTool(
      createSlackScheduleCreateTaskTool(
        createContext({
          userText: "drink water in 1 minute in this conversation",
        }),
      ),
      {
        title: "Drink water reminder",
        objective: "Remind David to drink water.",
        instructions: ["Remind David to drink water."],
        schedule_description: "In 1 minute",
        next_run_at_text: "in 1 minute",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-27T00:25:23.000Z",
        schedule: "In 1 minute",
        status: "active",
        title: "Drink water reminder",
      },
    });
    await expect(
      createStateSchedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        destination: { channelId: "C123" },
        nextRunAtMs: Date.parse("2026-05-27T00:25:23.000Z"),
        status: "active",
      },
    ]);
  });

  it("rejects parseable non-ISO next run timestamps", async () => {
    const result = await createTask(createContext(), {
      next_run_at_iso: "05/25/2026 09:00",
    });

    expect(result).toMatchObject({
      ok: false,
      error:
        'Provide next_run_at_iso as a valid ISO timestamp or next_run_at_text such as "tomorrow at 9am".',
    });
    await expect(
      createStateSchedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects conflicting exact and relative next run inputs", async () => {
    const result = await createTask(createContext(), {
      next_run_at_iso: "2026-05-25T16:00:00.000Z",
      next_run_at_text: "tomorrow at 9am",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Provide only one of next_run_at_iso or next_run_at_text.",
    });
    await expect(
      createStateSchedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects recurring schedules that can run more than once per day", async () => {
    const result = await createTask(createContext(), {
      schedule_description: "Every hour",
      recurrence_frequency: "hourly",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Recurring scheduled tasks can run at most once per day.",
    });
    await expect(
      createStateSchedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

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
        title: "Daily scheduler digest",
        schedule_description: "Every day at 9am",
        recurrence_frequency: "daily",
      },
    );
    expect(updated).toMatchObject({
      ok: true,
      task: {
        id: taskId,
        title: "Daily scheduler digest",
        schedule: "Every day at 9am",
        version: 2,
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

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(context),
      {
        task_id: created.task.id,
        schedule_description: "Every hour",
        recurrence_frequency: "hourly",
      },
    );

    expect(updated).toMatchObject({
      ok: false,
      error: "Recurring scheduled tasks can run at most once per day.",
    });
    await expect(
      createStateSchedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({
      schedule: {
        description: "Every Monday at 9am",
      },
      version: 1,
    });
  });

  it("rejects edits from another active Slack destination", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(createContext({ channelId: "C999" })),
      {
        task_id: created.task.id,
        title: "Wrong channel edit",
      },
    );

    expect(updated).toMatchObject({
      ok: false,
      error:
        "Scheduled task can only be managed from the Slack destination where it was created.",
    });
  });

  it("allows another requester to manage tasks in the same Slack destination", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const otherRequester = createContext({
      threadTs: "1700000003.000000",
      requester: {
        userId: "U999",
        userName: "alice",
        fullName: "Alice Reviewer",
      },
    });

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(otherRequester),
      {
        task_id: created.task.id,
        title: "Team-owned digest",
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
        title: "Team-owned digest",
        version: 2,
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
      createStateSchedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({
      status: "deleted",
      executionActor: {
        type: "system",
        id: "scheduled-task",
      },
      task: {
        title: "Team-owned digest",
      },
      version: 3,
    });
  });

  it("creates one-off tasks from tomorrow text using the default Pacific timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));

    const created = await createTask(createContext(), {
      next_run_at_iso: undefined,
      next_run_at_text: "tomorrow at 9am",
      recurrence_frequency: undefined,
      recurrence_weekdays: undefined,
      timezone: undefined,
    });

    expect(created).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-26T16:00:00.000Z",
        recurrence: null,
        timezone: "America/Los_Angeles",
      },
    });
  });

  it("uses JUNIOR_TIMEZONE as the default schedule timezone", async () => {
    process.env.JUNIOR_TIMEZONE = "America/New_York";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));

    const created = await createTask(createContext(), {
      next_run_at_iso: undefined,
      next_run_at_text: "tomorrow at 9am",
      recurrence_frequency: undefined,
      recurrence_weekdays: undefined,
      timezone: undefined,
    });

    expect(created).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-26T13:00:00.000Z",
        recurrence: null,
        timezone: "America/New_York",
      },
    });
  });

  it("rejects invalid default timezones", async () => {
    process.env.JUNIOR_TIMEZONE = "not/a-zone";

    const created = await createTask(createContext(), {
      timezone: undefined,
    });

    expect(created).toMatchObject({
      ok: false,
      error: "timezone must be a valid IANA time zone.",
    });
    await expect(
      createStateSchedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("preserves a recurring task calendar anchor on content-only edits", async () => {
    const context = createContext();
    const created = (await createTask(context, {
      recurrence_interval: 2,
    })) as {
      task: { id: string };
    };
    const store = createStateSchedulerStore();
    const task = await store.getTask(created.task.id);
    expect(task?.schedule.recurrence).toMatchObject({
      interval: 2,
      startDate: "2026-05-25",
    });
    await store.saveTask({
      ...task!,
      nextRunAtMs: Date.parse("2026-06-08T16:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-26T16:00:00.000Z"),
      version: task!.version + 1,
    });

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(context),
      {
        task_id: created.task.id,
        title: "Renamed issue digest",
      },
    );

    expect(updated).toMatchObject({
      ok: true,
      task: {
        title: "Renamed issue digest",
      },
    });
    await expect(store.getTask(created.task.id)).resolves.toMatchObject({
      nextRunAtMs: Date.parse("2026-06-08T16:00:00.000Z"),
      schedule: {
        recurrence: {
          interval: 2,
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
    const store = createStateSchedulerStore();
    const task = await store.getTask(created.task.id);
    expect(task).toBeDefined();
    await store.saveTask({
      ...task!,
      status: "blocked",
      statusReason: "Missing GitHub credentials.",
      updatedAtMs: Date.parse("2026-05-25T16:01:00.000Z"),
      version: task!.version + 1,
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

  it("marks an active task due immediately without changing its scheduled next run", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const store = createStateSchedulerStore();
    const task = await store.getTask(created.task.id);
    expect(task).toBeDefined();
    const scheduledNextRunAtMs = Date.parse("2026-06-01T16:00:00.000Z");
    await store.saveTask({
      ...task!,
      nextRunAtMs: scheduledNextRunAtMs,
      updatedAtMs: Date.parse("2026-05-25T16:01:00.000Z"),
      version: task!.version + 1,
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
        teamId: context.teamId,
        channelId: context.channelId,
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
    const store = createStateSchedulerStore();
    const task = await store.getTask(created.task.id);
    expect(task).toBeDefined();
    await store.saveTask({
      ...task!,
      status: "paused",
      statusReason: "Paused by user.",
      updatedAtMs: Date.parse("2026-05-25T16:01:00.000Z"),
      version: task!.version + 1,
    });

    const result = await executeTool(
      createSlackScheduleRunTaskNowTool(context),
      {
        task_id: created.task.id,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error:
        "Scheduled task must be active before it can be run now. Resume the task first if you want it to run.",
    });
    const paused = await store.getTask(created.task.id);
    expect(paused).toMatchObject({
      status: "paused",
      statusReason: "Paused by user.",
    });
    expect(paused?.runNowAtMs).toBeUndefined();
  });

  it("removes deleted tasks from scheduler indexes", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };

    await executeTool(createSlackScheduleDeleteTaskTool(context), {
      task_id: created.task.id,
    });

    const state = getStateAdapter();
    await state.connect();
    await expect(state.get<string[]>("junior:scheduler:tasks")).resolves.toBe(
      null,
    );
    await expect(
      state.get<string[]>(`junior:scheduler:team:${TEST_TEAM_ID}:tasks`),
    ).resolves.toBe(null);
  });

  it("claims due runs idempotently", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const store = createStateSchedulerStore();
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
