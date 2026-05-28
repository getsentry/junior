import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPluginToolInputError } from "@sentry/junior-plugin-api";
import {
  createSchedulerStore,
  createSlackScheduleCreateTaskTool,
  createSlackScheduleDeleteTaskTool,
  createSlackScheduleListTasksTool,
  createSlackScheduleRunTaskNowTool,
  createSlackScheduleUpdateTaskTool,
  type SchedulerToolContext,
} from "@sentry/junior-scheduler";
import { createPluginState } from "@/chat/plugins/state";
import { disconnectStateAdapter } from "@/chat/state/adapter";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

const TEST_TEAM_ID = `TSCHEDULE${Date.now()}`;

function createContext(
  overrides: Partial<SchedulerToolContext> = {},
): SchedulerToolContext {
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
    state: createPluginState("scheduler"),
    ...overrides,
  };
}

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

function schedulerStore() {
  return createSchedulerStore(createPluginState("scheduler"));
}

async function createTask(
  context = createContext(),
  overrides: Record<string, unknown> = {},
) {
  const tool = createSlackScheduleCreateTaskTool(context);
  return await executeTool(tool, {
    task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
    schedule: "Every Monday at 9am",
    timezone: "America/Los_Angeles",
    next_run_at: "2026-05-25T16:00:00.000Z",
    recurrence: "weekly",
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
        conversation_access: {
          audience: "channel",
          visibility: "unknown",
        },
        credential_subject: null,
        status: "active",
        task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
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
          task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
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
          task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
          schedule: "Every Monday at 9am",
        },
      ],
    });
  });

  it("creates clear recurring tasks without a second confirmation", async () => {
    const result = await executeTool(
      createSlackScheduleCreateTaskTool(createContext()),
      {
        task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
        schedule: "Every Monday at 9am",
        timezone: "America/Los_Angeles",
        next_run_at: "2026-05-25T16:00:00.000Z",
        recurrence: "weekly",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        schedule: "Every Monday at 9am",
        status: "active",
        task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
      },
    });
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        destination: { channelId: "C123" },
        status: "active",
      },
    ]);
  });

  it("rejects invalid Slack workspace context before creating a task", async () => {
    const rejected = executeTool(
      createSlackScheduleCreateTaskTool(createContext({ teamId: "D123" })),
      {
        task: "Reminder: Remind David to wash his hands.",
        schedule: "In 1 minute",
        next_run_at: "2026-05-27T00:25:23.000Z",
      },
    );

    await expect(rejected).rejects.toThrow(AgentPluginToolInputError);
    await expect(rejected).rejects.toThrow(
      "Active Slack workspace context is invalid.",
    );
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
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
        task: "Wash hands reminder: Remind David to wash his hands.",
        schedule: "In 1 minute",
        next_run_at: "2026-05-27T00:25:23.000Z",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-27T00:25:23.000Z",
        schedule: "In 1 minute",
        status: "active",
        task: "Wash hands reminder: Remind David to wash his hands.",
      },
    });
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        conversationAccess: {
          audience: "direct",
          visibility: "private",
        },
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
        },
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
        task: "Drink water reminder: Remind David to drink water.",
        schedule: "In 1 minute",
        next_run_at: "2026-05-27T00:25:23.000Z",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-27T00:25:23.000Z",
        schedule: "In 1 minute",
        status: "active",
        task: "Drink water reminder: Remind David to drink water.",
      },
    });
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        destination: { channelId: "C123" },
        nextRunAtMs: Date.parse("2026-05-27T00:25:23.000Z"),
        status: "active",
      },
    ]);
  });

  it("creates one-off reminders by omitting recurrence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T02:17:48.005Z"));

    const result = await executeTool(
      createSlackScheduleCreateTaskTool(
        createContext({
          userText: "remind greg to drink water in 1m",
        }),
      ),
      {
        task: "Remind Greg to drink water.",
        schedule: "In 1 minute",
        next_run_at: "2026-05-28T02:18:48.005Z",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        next_run_at: "2026-05-28T02:18:48.005Z",
        recurrence: null,
        schedule: "In 1 minute",
        status: "active",
        task: "Remind Greg to drink water.",
      },
    });
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        nextRunAtMs: Date.parse("2026-05-28T02:18:48.005Z"),
        schedule: {
          kind: "one_off",
          recurrence: undefined,
        },
        status: "active",
      },
    ]);
  });

  it("rejects parseable non-ISO next run timestamps", async () => {
    await expect(
      createTask(createContext(), {
        next_run_at: "05/25/2026 09:00",
      }),
    ).rejects.toThrow("Provide next_run_at as a valid ISO timestamp.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects missing next run timestamps with a tool error", async () => {
    await expect(
      createTask(createContext(), {
        next_run_at: undefined,
      }),
    ).rejects.toThrow("Provide next_run_at as a valid ISO timestamp.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects recurring schedules that can run more than once per day", async () => {
    await expect(
      createTask(createContext(), {
        schedule: "Every hour",
        recurrence: "hourly",
      }),
    ).rejects.toThrow(
      "Recurring scheduled tasks can run at most once per day.",
    );
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
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
      version: 1,
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
    await expect(
      schedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({
      schedule: {
        kind: "one_off",
        recurrence: undefined,
      },
    });
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
      version: 3,
    });
  });

  it("does not delegate user credentials in private group conversations", async () => {
    const result = await createTask(createContext({ channelId: "G123" }));

    expect(result).toMatchObject({
      ok: true,
      task: {
        conversation_access: {
          audience: "group",
          visibility: "private",
        },
        credential_subject: null,
      },
    });
    const tasks = await schedulerStore().listTasksForTeam(TEST_TEAM_ID);
    expect(tasks).toMatchObject([
      {
        conversationAccess: {
          audience: "group",
          visibility: "private",
        },
        destination: { channelId: "G123" },
      },
    ]);
    expect(tasks[0]?.credentialSubject).toBeUndefined();
  });

  it("normalizes Slack conversation ids before storing destinations", async () => {
    const result = await createTask(
      createContext({ channelId: "slack:D123:1700000000.000" }),
      {
        schedule: "In 1 minute",
        next_run_at: "2026-05-27T00:25:23.000Z",
        recurrence: undefined,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      task: {
        conversation_access: {
          audience: "direct",
          visibility: "private",
        },
      },
    });
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        destination: { channelId: "D123" },
      },
    ]);
  });

  it("creates one-off tasks with an exact timestamp using the default Pacific timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));

    const created = await createTask(createContext(), {
      schedule: "On May 26 at 9am",
      next_run_at: "2026-05-26T16:00:00.000Z",
      recurrence: undefined,
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
      schedule: "On May 26 at 9am",
      next_run_at: "2026-05-26T13:00:00.000Z",
      recurrence: undefined,
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

    await expect(
      createTask(createContext(), {
        timezone: undefined,
      }),
    ).rejects.toThrow("timezone must be a valid IANA time zone.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
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
      version: task!.version + 1,
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
    const store = schedulerStore();
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
    const store = schedulerStore();
    const task = await store.getTask(created.task.id);
    expect(task).toBeDefined();
    await store.saveTask({
      ...task!,
      status: "paused",
      statusReason: "Paused by user.",
      updatedAtMs: Date.parse("2026-05-25T16:01:00.000Z"),
      version: task!.version + 1,
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
