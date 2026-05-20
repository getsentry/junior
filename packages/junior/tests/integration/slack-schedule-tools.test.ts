import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createStateSchedulerStore } from "@/chat/scheduler/store";
import {
  createSlackScheduleCreateTaskTool,
  createSlackScheduleDeleteTaskTool,
  createSlackScheduleListTasksTool,
  createSlackScheduleUpdateTaskTool,
} from "@/chat/tools/slack/schedule-tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

const TEST_TEAM_ID = `T_SCHEDULE_${Date.now()}`;

function createContext(
  overrides: Partial<ToolRuntimeContext> = {},
): ToolRuntimeContext {
  return {
    channelId: "C123",
    teamId: TEST_TEAM_ID,
    threadTs: "1700000000.000000",
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

    const wrongThread = await executeTool(
      createSlackScheduleListTasksTool(
        createContext({ threadTs: "1700000999.000000" }),
      ),
      {},
    );
    expect(wrongThread).toMatchObject({
      ok: true,
      tasks: [],
    });
  });

  it("edits and deletes a task from the same Slack destination", async () => {
    const context = createContext({ threadTs: "1700000001.000000" });
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

  it("rejects edits from another active Slack destination", async () => {
    const context = createContext({ threadTs: "1700000002.000000" });
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

  it("rejects edits and deletes from another requester in the same Slack destination", async () => {
    const context = createContext({ threadTs: "1700000003.000000" });
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const otherRequester = createContext({
      threadTs: context.threadTs,
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
        title: "Hijacked digest",
      },
    );
    const deleted = await executeTool(
      createSlackScheduleDeleteTaskTool(otherRequester),
      {
        task_id: created.task.id,
      },
    );

    expect(updated).toMatchObject({
      ok: false,
      error:
        "Scheduled task can only be managed by the Slack user who created it.",
    });
    expect(deleted).toMatchObject({
      ok: false,
      error:
        "Scheduled task can only be managed by the Slack user who created it.",
    });
    await expect(
      createStateSchedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({
      status: "active",
      task: {
        title: "Weekly issue digest",
      },
      version: 1,
    });
  });

  it("preserves a recurring task calendar anchor on content-only edits", async () => {
    const context = createContext({ threadTs: "1700000004.000000" });
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

  it("removes deleted tasks from scheduler indexes", async () => {
    const context = createContext({ threadTs: "1700000005.000000" });
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
    const context = createContext({ threadTs: "1700000006.000000" });
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

    const first = await store.claimDueRuns({ nowMs: 2000, limit: 10 });
    const second = await store.claimDueRuns({ nowMs: 2000, limit: 10 });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      taskId: created.task.id,
      scheduledForMs: 1000,
      status: "pending",
    });
    expect(second).toHaveLength(0);
  });
});
