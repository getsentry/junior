import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectStateAdapter } from "@/chat/state/adapter";
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

async function createTask(context = createContext()) {
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

  it("claims due runs idempotently", async () => {
    const context = createContext({ threadTs: "1700000003.000000" });
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
