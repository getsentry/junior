import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  createSchedulerSqlStore,
  createSlackScheduleCreateTaskTool,
  createSlackScheduleDeleteTaskTool,
  createSlackScheduleFindTasksTool,
  createSlackScheduleListTasksTool,
  createSlackScheduleMoveTaskTool,
  createSlackScheduleRunTaskNowTool,
  createSlackScheduleUpdateTaskTool,
  type ScheduledTask,
  type SchedulerDb,
  type SchedulerToolContext,
} from "@/chat/scheduled-tasks";
import * as dbModule from "@/chat/db";
import { getPluginTools, setPlugins } from "@/chat/plugins/agent-hooks";
import { createTools } from "@/chat/tools";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { ToolExecuteOptions } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  createLocalJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

const TEST_TEAM_ID = `TSCHEDULE${Date.now()}`;
let currentFixture: LocalJuniorSqlFixture | undefined;
let currentSchedulerStore: SchedulerToolContext["store"] | undefined;
let toolCallSequence = 0;

async function useSchedulerSqlPlugin() {
  const fixture = await createLocalJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const db = fixture.sql.db() as unknown as SchedulerDb;
  vi.spyOn(dbModule, "getDb").mockReturnValue(fixture.sql.db());
  return {
    fixture,
    store: createSchedulerSqlStore(db),
  };
}

function createContext(
  overrides: Partial<SchedulerToolContext> & {
    channelId?: string;
    linkedUser?: boolean;
    teamId?: string;
  } = {},
): SchedulerToolContext {
  const channelId = overrides.channelId ?? "C123";
  const teamId = overrides.teamId ?? TEST_TEAM_ID;
  const contextOverrides = { ...overrides };
  delete contextOverrides.channelId;
  delete contextOverrides.linkedUser;
  delete contextOverrides.teamId;
  const actor = overrides.actor ?? {
    platform: "slack" as const,
    teamId,
    userId: "U123",
    userName: "dcramer",
    fullName: "David Cramer",
  };
  const identity = {
    id: `identity:${actor.teamId}:${actor.userId}`,
    provider: "slack",
    providerSubjectId: actor.userId,
    providerTenantId: actor.teamId,
  };
  const user =
    overrides.linkedUser === false
      ? undefined
      : {
          email: `${actor.userId.toLowerCase()}@example.com`,
          id: `user:${actor.userId}`,
          identities: [identity],
        };
  const context: SchedulerToolContext = {
    source: createSlackSource({
      teamId,
      channelId,

      visibility: channelId.startsWith("C") ? "public" : "private",
    }),
    actor,
    now: () => Date.parse("2026-05-24T12:00:00.000Z"),
    userText: "schedule this weekly",
    store: schedulerStore(),
    users: {
      resolveActor: async () => ({ identity, ...(user ? { user } : {}) }),
    },
    ...contextOverrides,
  };
  return context;
}

async function executeTool<TOutput>(
  tool: {
    execute?: (
      input: unknown,
      options: ToolExecuteOptions,
    ) => Promise<TOutput> | TOutput;
    prepareArguments?: (input: unknown) => unknown;
  },
  input: unknown,
  options: ToolExecuteOptions = {},
): Promise<TOutput> {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  const prepared = tool.prepareArguments?.(input) ?? input;
  return await tool.execute(prepared, {
    toolCallId: `test-scheduler-call-${toolCallSequence++}`,
    ...options,
  });
}

async function executeRegisteredTool<TDetails>(
  tool: {
    execute?: (input: unknown, options: {}) => Promise<unknown> | unknown;
    prepareArguments?: (input: unknown) => unknown;
  },
  input: unknown,
): Promise<TDetails> {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return (await tool.execute(tool.prepareArguments?.(input) ?? input, {
    toolCallId: `test-scheduler-call-${toolCallSequence++}`,
  })) as TDetails;
}

function schedulerStore() {
  if (!currentSchedulerStore) {
    throw new Error("Scheduler SQL store is not initialized");
  }
  return currentSchedulerStore;
}

async function initializeSchedulerSqlStore(): Promise<void> {
  const plugin = await useSchedulerSqlPlugin();
  currentFixture = plugin.fixture;
  currentSchedulerStore = plugin.store;
}

async function cleanupSchedulerSqlStore(): Promise<void> {
  await currentFixture?.close();
  currentFixture = undefined;
  currentSchedulerStore = undefined;
}

async function createTask(
  context = createContext(),
  overrides: Record<string, unknown> = {},
) {
  const tool = createSlackScheduleCreateTaskTool(context);
  return await executeTool(tool, {
    task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
    schedule: {
      kind: "recurring",
      frequency: "weekly",
      time: "09:00",
      weekdays: ["monday"],
      timezone: "America/Los_Angeles",
    },
    ...overrides,
  });
}

describe("Slack schedule tools", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    await initializeSchedulerSqlStore();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.JUNIOR_TIMEZONE;
    await cleanupSchedulerSqlStore();
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it("exposes a required structured schedule without model-computed timestamps", async () => {
    const createTool = createSlackScheduleCreateTaskTool(createContext());
    const updateTool = createSlackScheduleUpdateTaskTool(createContext());
    const deleteTool = createSlackScheduleDeleteTaskTool(createContext());
    const runNowTool = createSlackScheduleRunTaskNowTool(createContext());
    const listTool = createSlackScheduleListTasksTool(createContext());
    const schema = createTool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(createTool.approvalMode).toBe("review");
    expect(updateTool.approvalMode).toBe("review");
    expect(deleteTool.approvalMode).toBe("review");
    expect(runNowTool.approvalMode).toBe("review");
    // Read-only listing stays outside Guardian; mutating schedule tools do not.
    expect(listTool.approvalMode).toBeUndefined();
    expect(schema.required).toContain("schedule");
    expect(schema.properties).not.toHaveProperty("next_run_at");
    expect(schema.properties).not.toHaveProperty("schedule_kind");
    expect(
      (updateTool.inputSchema as { properties?: Record<string, unknown> })
        .properties,
    ).toHaveProperty("credential_mode");
  });

  it("accepts a structured relative one-off schedule", async () => {
    const tool = createSlackScheduleCreateTaskTool(createContext());

    expect(
      tool.prepareArguments?.({
        task: "Remind Greg to drink water.",
        schedule: {
          kind: "one_off",
          timezone: null,
          timing: { type: "after", value: 1, unit: "minute" },
        },
      }),
    ).toMatchObject({
      schedule: {
        kind: "one_off",
        timezone: null,
        timing: { type: "after" },
      },
    });
  });

  it("creates and lists tasks only for the active Slack conversation", async () => {
    const created = await createTask();
    expect(created).toMatchObject({
      task: {
        conversation_access: {
          audience: "channel",
          visibility: "public",
        },
        credential_mode: "creator",
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
    await expect(
      schedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({
      creatorIdentityId: `identity:${TEST_TEAM_ID}:U123`,
    });
    expect(created).not.toHaveProperty("data");

    const listed = await executeTool(
      createSlackScheduleListTasksTool(createContext()),
      {},
    );
    expect(listed).toMatchObject({
      tasks: [
        {
          task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
          schedule: "Every week on Monday at 09:00 (America/Los_Angeles)",
        },
      ],
    });
    expect(listed).not.toHaveProperty("data");

    const sameChannelOtherThread = await executeTool(
      createSlackScheduleListTasksTool(createContext()),
      {},
    );
    expect(sameChannelOtherThread).toMatchObject({
      tasks: [
        {
          task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
          schedule: "Every week on Monday at 09:00 (America/Los_Angeles)",
        },
      ],
    });
  });

  it("stores identity ownership before the creator is linked to a user", async () => {
    const context = createContext({ linkedUser: false });
    const created = await createTask(context);

    const stored = await schedulerStore().getTask(created.task.id);
    expect(stored).toMatchObject({
      creatorIdentityId: `identity:${TEST_TEAM_ID}:U123`,
    });
  });

  it("creates clear recurring tasks without a second confirmation", async () => {
    const result = await executeTool(
      createSlackScheduleCreateTaskTool(createContext()),
      {
        task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
        schedule: {
          kind: "recurring",
          frequency: "weekly",
          time: "09:00",
          weekdays: ["monday"],
          timezone: "America/Los_Angeles",
        },
      },
    );

    expect(result).toMatchObject({
      task: {
        schedule: "Every week on Monday at 09:00 (America/Los_Angeles)",
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

  it("returns the existing task when a create tool call is replayed", async () => {
    let nowCalls = 0;
    const context = createContext({
      now: () => Date.parse("2026-05-24T12:00:00.000Z") + nowCalls++ * 1_000,
    });
    const tool = createSlackScheduleCreateTaskTool(context);
    const input = {
      task: "Post the scheduler reminder.",
      schedule: {
        kind: "one_off" as const,
        timing: {
          type: "after" as const,
          value: 1,
          unit: "minute" as const,
        },
      },
    };

    const [first, replay] = await Promise.all([
      executeTool(tool, input, { toolCallId: "call-create-1" }),
      executeTool(tool, input, { toolCallId: "call-create-1" }),
    ]);

    expect(replay.task.id).toBe(first.task.id);
    expect(replay.task.next_run_at).toBe(first.task.next_run_at);
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toHaveLength(1);
  });

  it("allows separate create calls to make equivalent tasks", async () => {
    const tool = createSlackScheduleCreateTaskTool(createContext());
    const input = {
      task: "Post the reminder.",
      schedule: {
        kind: "one_off" as const,
        timing: {
          type: "after" as const,
          value: 1,
          unit: "minute" as const,
        },
      },
    };

    const first = await executeTool(tool, input, {
      toolCallId: "call-create-first",
    });
    const second = await executeTool(tool, input, {
      toolCallId: "call-create-second",
    });

    expect(second.task.id).not.toBe(first.task.id);
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toHaveLength(2);
  });

  it("does not store Slack ids as creator display identity", async () => {
    const created = (await createTask(
      createContext({
        actor: {
          platform: "slack",
          teamId: TEST_TEAM_ID,
          userId: "U039RR91S",
          userName: "unknown",
          fullName: "W039RR91S",
        },
      }),
    )) as { task: { id: string } };

    await expect(schedulerStore().getTask(created.task.id)).resolves.toEqual(
      expect.objectContaining({
        createdBy: {
          slackUserId: "U039RR91S",
        },
      }),
    );
  });

  it("rejects synthetic unknown actor ids before creating a task", async () => {
    const rejected = createTask(
      createContext({
        actor: {
          platform: "slack",
          teamId: TEST_TEAM_ID,
          userId: "unknown",
          userName: "unknown",
          fullName: "unknown",
        },
      }),
    );

    await expect(rejected).rejects.toThrow(ToolInputError);
    await expect(rejected).rejects.toThrow(
      "No active Slack actor context is available.",
    );
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects invalid Slack source before creating a task", async () => {
    const rejected = executeTool(
      createSlackScheduleCreateTaskTool(createContext({ teamId: "D123" })),
      {
        task: "Reminder: Remind David to wash his hands.",
        schedule: {
          kind: "one_off",
          timing: { type: "after", value: 1, unit: "minute" },
        },
        credential_mode: null,
      },
    );

    await expect(rejected).rejects.toThrow(ToolInputError);
    await expect(rejected).rejects.toThrow(
      "Active Slack conversation workspace is invalid.",
    );
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("accepts Slack source message context and stores canonical task destinations", async () => {
    const result = await createTask(
      createContext({
        source: createSlackSource({
          teamId: TEST_TEAM_ID,
          channelId: "C123",
          threadTs: "1700000000.000",

          visibility: "private",
        }),
      }),
    );

    const taskId = (result as { task: { id: string } }).task.id;
    await expect(schedulerStore().getTask(taskId)).resolves.toMatchObject({
      destination: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        channelId: "C123",
      },
    });
  });

  it("rejects invalid scheduled task routing context at the store boundary", async () => {
    await createTask();
    const task = (await schedulerStore().listTasks()).at(0);
    if (!task) {
      throw new Error("Expected scheduled task to be created");
    }

    await expect(
      schedulerStore().saveTask({
        ...task,
        id: "sched_bad_destination",
        destination: {
          platform: "slack",
          teamId: "0BADTEAM",
          channelId: "D123",
        },
      }),
    ).rejects.toThrow("Scheduled task routing context is invalid.");
    await expect(
      schedulerStore().getTask("sched_bad_destination"),
    ).resolves.toBe(undefined);

    await expect(
      schedulerStore().saveTask({
        ...task,
        id: "sched_bad_credential_mode",
        credentialMode: "invalid" as ScheduledTask["credentialMode"],
      }),
    ).rejects.toThrow("Scheduled task routing context is invalid.");
    await expect(
      schedulerStore().getTask("sched_bad_credential_mode"),
    ).resolves.toBe(undefined);

    await expect(
      schedulerStore().saveTask({
        ...task,
        id: "sched_bad_creator",
        createdBy: { slackUserId: "unknown" },
      }),
    ).rejects.toThrow("Scheduled task routing context is invalid.");
    await expect(schedulerStore().getTask("sched_bad_creator")).resolves.toBe(
      undefined,
    );
  });

  it("computes relative one-off runs from the trusted clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:24:23.000Z"));

    const result = await executeTool(
      createSlackScheduleCreateTaskTool(
        createContext({
          channelId: "D123",
          now: () => Date.now(),
          userText: "remind me in 1 minute to wash my hands",
        }),
      ),
      {
        task: "Wash hands reminder: Remind David to wash his hands.",
        schedule: {
          kind: "one_off",
          timing: { type: "after", value: 1, unit: "minute" },
        },
      },
    );

    expect(result).toMatchObject({
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
        credentialMode: "creator",
        destination: { channelId: "D123" },
        nextRunAtMs: Date.parse("2026-05-27T00:25:23.000Z"),
        status: "active",
      },
    ]);
  });

  it("rejects malformed local dates", async () => {
    await expect(
      createTask(createContext(), {
        schedule: {
          kind: "one_off",
          timing: { type: "at", date: "05/25/2026", time: "09:00" },
        },
      }),
    ).rejects.toThrow("Use a local date in YYYY-MM-DD format.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects missing structured schedules with a tool error", async () => {
    await expect(
      createTask(createContext(), {
        schedule: undefined,
      }),
    ).rejects.toThrow("schedule");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects unsupported recurring frequencies", async () => {
    await expect(
      createTask(createContext(), {
        schedule: {
          kind: "recurring",
          frequency: "hourly",
          time: "09:00",
        },
      }),
    ).rejects.toThrow("Invalid tool arguments: schedule");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects removed top-level scheduling fields", async () => {
    await expect(
      createTask(createContext(), {
        next_run_at: "2026-05-25T16:00:00.000Z",
      }),
    ).rejects.toThrow("Unrecognized key");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects weekly schedules without weekdays", async () => {
    await expect(
      createTask(createContext(), {
        schedule: {
          kind: "recurring",
          frequency: "weekly",
          time: "09:00",
        },
      }),
    ).rejects.toThrow("Weekly schedules require weekdays.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects recurring fields that contradict the selected frequency", async () => {
    await expect(
      createTask(createContext(), {
        schedule: {
          kind: "recurring",
          frequency: "daily",
          time: "09:00",
          weekdays: ["monday"],
        },
      }),
    ).rejects.toThrow("weekdays applies only to weekly schedules.");
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
        task: "Tuesday scheduler digest: Summarize open scheduler issues.",
        schedule: {
          kind: "recurring",
          frequency: "weekly",
          time: "10:00",
          weekdays: ["tuesday"],
        },
      },
    );
    expect(updated).toMatchObject({
      task: {
        id: taskId,
        next_run_at: "2026-05-26T17:00:00.000Z",
        task: "Tuesday scheduler digest: Summarize open scheduler issues.",
        schedule: "Every week on Tuesday at 10:00 (America/Los_Angeles)",
      },
    });
    await expect(schedulerStore().getTask(taskId)).resolves.toMatchObject({
      nextRunAtMs: Date.parse("2026-05-26T17:00:00.000Z"),
      schedule: {
        recurrence: {
          frequency: "weekly",
          time: { hour: 10, minute: 0 },
          weekdays: [2],
        },
      },
    });

    const deleted = await executeTool(
      createSlackScheduleDeleteTaskTool(context),
      {
        task_id: taskId,
      },
    );
    expect(deleted).toMatchObject({
      task: {
        id: taskId,
        status: "deleted",
      },
    });

    const listed = await executeTool(
      createSlackScheduleListTasksTool(context),
      {},
    );
    expect(listed).toMatchObject({ tasks: [] });
  });

  it("treats a null update schedule as omitted", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string; next_run_at: string; task: string };
    };

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(context),
      {
        task_id: created.task.id,
        schedule: null,
        task: `${created.task.task} (edited)`,
      },
    );

    expect(updated).toMatchObject({
      task: {
        id: created.task.id,
        next_run_at: created.task.next_run_at,
        status: "active",
        task: `${created.task.task} (edited)`,
      },
    });
  });

  it("rejects removed top-level rescheduling fields", async () => {
    const context = createContext();
    const created = (await createTask(context)) as { task: { id: string } };
    const tool = createSlackScheduleUpdateTaskTool(context);

    await expect(
      executeTool(tool, {
        task_id: created.task.id,
        next_run_at: "2026-06-01T16:00:00.000Z",
      } as unknown as Parameters<NonNullable<typeof tool.execute>>[0]),
    ).rejects.toThrow("Unrecognized key");
    await expect(
      schedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({
      nextRunAtMs: Date.parse("2026-05-25T16:00:00.000Z"),
    });
  });

  it("rejects edits with an unsupported recurring frequency", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const updateTool = createSlackScheduleUpdateTaskTool(context);

    await expect(
      executeTool(updateTool, {
        task_id: created.task.id,
        schedule: {
          kind: "recurring",
          frequency: "hourly",
          time: "09:00",
        },
      } as unknown as Parameters<NonNullable<typeof updateTool.execute>>[0]),
    ).rejects.toThrow("Invalid tool arguments: schedule");
    await expect(
      schedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({
      schedule: {
        description: "Every week on Monday at 09:00 (America/Los_Angeles)",
      },
    });
  });

  it("converts recurring tasks to one-off tasks with a full schedule replacement", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(context),
      {
        task_id: created.task.id,
        schedule: {
          kind: "one_off",
          timing: { type: "at", date: "2026-06-01", time: "09:00" },
        },
      },
    );

    expect(updated).toMatchObject({
      task: {
        id: created.task.id,
        next_run_at: "2026-06-01T16:00:00.000Z",
        recurrence: null,
        schedule: "Once on 2026-06-01 at 09:00 (America/Los_Angeles)",
      },
    });
    await expect(
      schedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({
      schedule: {
        kind: "one_off",
      },
    });
  });

  it("rejects edits from another active Slack conversation", async () => {
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

  it("binds tasks to the raw conversation channel, not the assistant context channel", async () => {
    // The scheduler receives an active Source built from the raw conversation
    // channel by runtime wiring. Management works from any context with the
    // same source conversation.
    //
    // In practice: a DM opened via Slack’s “Ask Junior” panel from #js-alerts
    // has getPluginTools build source.channelId = DDM rather than using
    // the outbound assistant-context channel. Both creation and management
    // from that DM use DDM, so the stored task destination never drifts.
    const dmCtx = createContext({ channelId: "DDM" });
    const created = (await createTask(dmCtx)) as { task: { id: string } };
    const taskId = created.task.id;

    // Task is bound to the DM channel, not any assistant source channel.
    await expect(schedulerStore().getTask(taskId)).resolves.toMatchObject({
      destination: { channelId: "DDM" },
    });

    // Any context that resolves to the same DM channel can list and manage.
    const listed = await executeTool(
      createSlackScheduleListTasksTool(createContext({ channelId: "DDM" })),
      {},
    );
    expect(listed).toMatchObject({
      tasks: [{ id: taskId }],
    });

    const deleted = await executeTool(
      createSlackScheduleDeleteTaskTool(createContext({ channelId: "DDM" })),
      { task_id: taskId },
    );
    expect(deleted).toMatchObject({
      task: { id: taskId, status: "deleted" },
    });
  });

  it("rejects management from a different conversation channel", async () => {
    // A task created in Alice’s DM cannot be managed from Bob’s DM.
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

  it("allows another actor to manage tasks in the same Slack destination", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
      task: { id: string };
    };
    const otherActor = createContext({
      actor: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        userId: "U999",
        userName: "alice",
        fullName: "Alice Reviewer",
      },
    });

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(otherActor),
      {
        task_id: created.task.id,
        task: "Team-owned digest: Summarize open scheduler issues.",
      },
    );
    const deleted = await executeTool(
      createSlackScheduleDeleteTaskTool(otherActor),
      {
        task_id: created.task.id,
      },
    );

    expect(updated).toMatchObject({
      task: {
        id: created.task.id,
        task: "Team-owned digest: Summarize open scheduler issues.",
      },
    });
    expect(deleted).toMatchObject({
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
        platform: "system",
        name: "scheduled-task",
      },
      task: {
        text: "Team-owned digest: Summarize open scheduler issues.",
      },
    });
  });

  it("stores creator credential mode by default in channels", async () => {
    const created = await createTask(createContext());

    expect(created).toMatchObject({
      task: { credential_mode: "creator" },
    });
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toMatchObject([
      {
        createdBy: { slackUserId: "U123" },
        credentialMode: "creator",
        destination: { channelId: "C123" },
      },
    ]);
  });

  it("accepts explicit creator credential mode when creating a task", async () => {
    const context = createContext();
    const tool = createSlackScheduleCreateTaskTool(context);
    const input = {
      task: "Weekly issue digest: Summarize open scheduler issues.",
      schedule: {
        kind: "recurring" as const,
        frequency: "weekly" as const,
        time: "09:00",
        weekdays: ["monday" as const],
        timezone: "America/Los_Angeles",
      },
      credential_mode: "creator" as const,
    };

    expect(tool.prepareArguments?.(input)).not.toHaveProperty(
      "credential_mode",
    );
    expect(
      tool.prepareArguments?.({ ...input, credential_mode: null }),
    ).not.toHaveProperty("credential_mode");
    expect(
      tool.prepareArguments?.({ ...input, credential_mode: "system" }),
    ).toHaveProperty("credential_mode", "system");
    const created = await executeTool(tool, input);

    expect(created).toMatchObject({
      task: { credential_mode: "creator" },
    });
  });

  it("clears creator credentials when another user changes task text", async () => {
    const context = createContext();
    const created = (await createTask(context)) as { task: { id: string } };
    const otherActor = createContext({
      actor: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        userId: "U999",
      },
    });

    await executeTool(createSlackScheduleUpdateTaskTool(otherActor), {
      task_id: created.task.id,
      schedule: {
        kind: "recurring",
        frequency: "weekly",
        time: "09:00",
        weekdays: ["tuesday"],
        timezone: "America/Los_Angeles",
      },
    });
    await expect(
      schedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({ credentialMode: "creator" });

    await executeTool(createSlackScheduleUpdateTaskTool(otherActor), {
      task_id: created.task.id,
      task: "Weekly issue digest: Summarize open scheduler issues and post a concise summary.",
    });
    await expect(
      schedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({ credentialMode: "creator" });

    const updated = await executeTool(
      createSlackScheduleUpdateTaskTool(otherActor),
      {
        task_id: created.task.id,
        task: "Team-owned digest: Summarize open scheduler issues.",
      },
    );
    expect(updated).toMatchObject({
      task: { credential_mode: "system" },
    });
    await expect(
      schedulerStore().getTask(created.task.id),
    ).resolves.toMatchObject({ credentialMode: "system" });
  });

  it("updates credential availability and allows only the creator to enable it", async () => {
    const context = createContext();
    const created = await createTask(context);
    expect(created).toMatchObject({
      task: { credential_mode: "creator" },
    });
    const taskId = (created as { task: { id: string } }).task.id;
    const original = await schedulerStore().getTask(taskId);
    if (!original) {
      throw new Error("Expected scheduled task to exist");
    }
    const otherActor = createContext({
      actor: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        userId: "U999",
      },
    });

    await expect(
      executeTool(createSlackScheduleUpdateTaskTool(otherActor), {
        task_id: taskId,
        credential_mode: "system",
      }),
    ).resolves.toMatchObject({
      task: { credential_mode: "system" },
    });
    await expect(schedulerStore().getTask(taskId)).resolves.toMatchObject({
      credentialMode: "system",
      destination: original.destination,
      nextRunAtMs: original.nextRunAtMs,
      schedule: original.schedule,
      status: original.status,
      task: original.task,
    });

    await expect(
      executeTool(createSlackScheduleUpdateTaskTool(otherActor), {
        task_id: taskId,
        credential_mode: "creator",
      }),
    ).rejects.toThrow(
      "Only the scheduled task creator can enable creator credential use.",
    );

    await expect(
      executeTool(createSlackScheduleUpdateTaskTool(context), {
        task_id: taskId,
        credential_mode: "creator",
      }),
    ).resolves.toMatchObject({
      task: { credential_mode: "creator" },
    });
  });

  it("rejects creator identity from another Slack workspace", async () => {
    await expect(
      createTask(
        createContext({
          actor: {
            platform: "slack",
            teamId: "TOTHER",
            userId: "U123",
          },
        }),
      ),
    ).rejects.toThrow("No active Slack actor context is available.");
  });

  it("makes creator credentials available in private group conversations", async () => {
    const result = await createTask(createContext({ channelId: "G123" }));

    expect(result).toMatchObject({
      task: {
        conversation_access: {
          audience: "group",
          visibility: "private",
        },
        credential_mode: "creator",
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
    expect(tasks[0]?.credentialMode).toBe("creator");
  });

  it("rejects non-canonical Slack sources before storing tasks", async () => {
    const context = createContext({ channelId: "D123" });
    await expect(
      createTask(
        {
          ...context,
          source: {
            ...createSlackSource({
              teamId: TEST_TEAM_ID,
              channelId: "D123",

              visibility: "private",
            }),
            teamId: TEST_TEAM_ID,
            channelId: "slack:D123:1700000000.000",
          },
        },
        {
          schedule: {
            kind: "one_off",
            timing: { type: "after", value: 1, unit: "minute" },
          },
        },
      ),
    ).rejects.toThrow("Active Slack conversation channel is invalid.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("stores canonical Slack destinations directly", async () => {
    const result = await createTask(createContext({ channelId: "D123" }), {
      schedule: {
        kind: "one_off",
        timing: { type: "after", value: 1, unit: "minute" },
      },
    });

    expect(result).toMatchObject({
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

  it("computes one-off timestamps from local time in the default Pacific timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));

    const created = await createTask(createContext(), {
      schedule: {
        kind: "one_off",
        timing: { type: "at", date: "2026-05-26", time: "09:00" },
      },
    });

    expect(created).toMatchObject({
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
      schedule: {
        kind: "one_off",
        timing: { type: "at", date: "2026-05-26", time: "09:00" },
      },
    });

    expect(created).toMatchObject({
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
        schedule: {
          kind: "one_off",
          timing: { type: "after", value: 1, unit: "minute" },
        },
      }),
    ).rejects.toThrow("timezone must be a valid IANA time zone.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("preserves a recurring task calendar anchor on content-only edits", async () => {
    const context = createContext();
    const created = (await createTask(context)) as {
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
        slackUserId: context.actor?.userId,
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

  it("does not run-now a blocked task", async () => {
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
      statusReason: "Blocked until credentials are available.",
      updatedAtMs: Date.parse("2026-05-25T16:01:00.000Z"),
    });

    await expect(
      executeTool(createSlackScheduleRunTaskNowTool(context), {
        task_id: created.task.id,
      }),
    ).rejects.toThrow("Scheduled task must be active before it can be run now.");
    const blocked = await store.getTask(created.task.id);
    expect(blocked).toMatchObject({
      status: "blocked",
      statusReason: "Blocked until credentials are available.",
    });
    expect(blocked?.runNowAtMs).toBeUndefined();
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

  it("finds only the requester's tasks and can filter by source channel", async () => {
    const creator = createContext({ channelId: "CSOURCE" });
    const otherChannel = createContext({ channelId: "COTHER" });
    const otherActor = createContext({
      channelId: "CSOURCE",
      actor: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        userId: "U999",
        userName: "bob",
        fullName: "Bob Example",
      },
    });

    const mine = (await createTask(creator, {
      task: "Weekly planning reminder: post the agenda here.",
    })) as { task: { id: string } };
    await createTask(otherChannel, {
      task: "Weekly planning reminder: post the agenda here.",
    });
    await createTask(otherActor, {
      task: "Someone else's planning reminder.",
    });

    const found = await executeTool(
      createSlackScheduleFindTasksTool(createContext({ channelId: "CTARGET" })),
      {
        channel_id: "CSOURCE",
        query: "planning reminder",
      },
    );

    expect(found).toMatchObject({
      tasks: [
        {
          id: mine.task.id,
          destination: {
            platform: "slack",
            team_id: TEST_TEAM_ID,
            channel_id: "CSOURCE",
          },
          task: "Weekly planning reminder: post the agenda here.",
        },
      ],
      truncated: false,
    });
  });

  it("moves a creator-owned task into the active public or private destination", async () => {
    const source = createContext({ channelId: "CSOURCE" });
    const created = (await createTask(source, {
      task: "Weekly planning reminder: post the agenda here.",
    })) as {
      task: {
        id: string;
        next_run_at: string | null;
        schedule: string;
        credential_mode: string;
      };
    };

    const publicTarget = createContext({ channelId: "CTARGET" });
    const movedPublic = await executeTool(
      createSlackScheduleMoveTaskTool(publicTarget),
      { task_id: created.task.id },
    );
    expect(movedPublic).toMatchObject({
      task: {
        id: created.task.id,
        task: "Weekly planning reminder: post the agenda here.",
        schedule: created.task.schedule,
        next_run_at: created.task.next_run_at,
        credential_mode: "creator",
        destination: {
          platform: "slack",
          team_id: TEST_TEAM_ID,
          channel_id: "CTARGET",
        },
        conversation_access: {
          audience: "channel",
          visibility: "public",
        },
      },
    });

    await expect(
      executeTool(createSlackScheduleListTasksTool(source), {}),
    ).resolves.toMatchObject({ tasks: [] });
    await expect(
      executeTool(createSlackScheduleListTasksTool(publicTarget), {}),
    ).resolves.toMatchObject({
      tasks: [{ id: created.task.id }],
    });

    const privateTarget = createContext({ channelId: "GPRIVATE" });
    const movedPrivate = await executeTool(
      createSlackScheduleMoveTaskTool(privateTarget),
      { task_id: created.task.id },
    );
    expect(movedPrivate).toMatchObject({
      task: {
        id: created.task.id,
        destination: {
          channel_id: "GPRIVATE",
          team_id: TEST_TEAM_ID,
        },
        conversation_access: {
          audience: "group",
          visibility: "private",
        },
        credential_mode: "creator",
        next_run_at: created.task.next_run_at,
      },
    });

    // Replaying a move that already landed is a no-op success.
    await expect(
      executeTool(createSlackScheduleMoveTaskTool(privateTarget), {
        task_id: created.task.id,
      }),
    ).resolves.toMatchObject({
      task: {
        id: created.task.id,
        destination: { channel_id: "GPRIVATE" },
      },
    });
  });

  it("rejects unauthorized, cross-workspace, and in-flight moves", async () => {
    const source = createContext({ channelId: "CSOURCE" });
    const created = (await createTask(source)) as { task: { id: string } };
    const otherActor = createContext({
      channelId: "CTARGET",
      actor: {
        platform: "slack",
        teamId: TEST_TEAM_ID,
        userId: "U999",
        userName: "bob",
        fullName: "Bob Example",
      },
    });

    await expect(
      executeTool(createSlackScheduleMoveTaskTool(otherActor), {
        task_id: created.task.id,
      }),
    ).rejects.toThrow("Only the scheduled task creator can move this task.");

    await expect(
      executeTool(
        createSlackScheduleMoveTaskTool(
          createContext({ channelId: "CTARGET", teamId: "TOTHER" }),
        ),
        { task_id: created.task.id },
      ),
    ).rejects.toThrow(
      "Scheduled tasks can only be moved within the same Slack workspace.",
    );

    const store = schedulerStore();
    const task = await store.getTask(created.task.id);
    expect(task).toBeDefined();
    await store.saveTask({
      ...task!,
      nextRunAtMs: 1000,
      updatedAtMs: 1000,
    });
    await expect(store.claimDueRun({ nowMs: 2000 })).resolves.toMatchObject({
      taskId: created.task.id,
      status: "pending",
    });

    await expect(
      executeTool(createSlackScheduleMoveTaskTool(createContext({ channelId: "CTARGET" })), {
        task_id: created.task.id,
      }),
    ).rejects.toThrow(
      "Scheduled task cannot be moved while an occurrence is already running",
    );

    await expect(
      store.getTask(created.task.id),
    ).resolves.toMatchObject({
      destination: { channelId: "CSOURCE" },
    });
  });
});

describe("Slack schedule tool wiring via createTools", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("scheduler tools bind to the runtime-owned source", async () => {
    // Verifies that real getPluginTools wiring passes Source through to
    // the scheduler, which stores it as the task destination.
    const previous = setPlugins([]);
    const { fixture, store } = await useSchedulerSqlPlugin();
    try {
      const TEAM_ID = `TWIRING${Date.now()}`;
      const identity = {
        id: `identity:${TEAM_ID}:U123`,
        provider: "slack",
        providerSubjectId: "U123",
        providerTenantId: TEAM_ID,
      };
      const user = {
        email: "alice@example.com",
        id: "user:alice",
        identities: [identity],
      };
      const resolveActorIdentity = vi.fn(async () => ({ identity, user }));
      const tools = createTools(
        [],
        {},
        {
          source: createSlackSource({
            teamId: TEAM_ID,
            channelId: "DDM",

            visibility: "private",
          }),
          destination: {
            platform: "slack",
            teamId: TEAM_ID,
            channelId: "DDM",
          },
          actor: {
            platform: "slack",
            teamId: TEAM_ID,
            userId: "U123",
            userName: "alice",
            fullName: "Alice",
          },
          egress: {
            async fetch() {
              return new Response("ok");
            },
          },
          resolveActorIdentity,
          workspace: {} as Parameters<typeof getPluginTools>[0]["workspace"],
        },
      );

      expect(tools).toHaveProperty("slackScheduleCreateTask");
      expect(resolveActorIdentity).not.toHaveBeenCalled();

      // Create a task through the real wired tool.
      const result = await executeRegisteredTool<{
        task: { id: string };
      }>(tools.slackScheduleCreateTask, {
        task: "Wiring test: post a weekly digest.",
        schedule: {
          kind: "recurring",
          frequency: "weekly",
          time: "09:00",
          weekdays: ["monday"],
          start_date: "2026-06-09",
          timezone: "America/Los_Angeles",
        },
      });

      expect(resolveActorIdentity).toHaveBeenCalledOnce();
      const taskId = result.task.id;

      // Task destination must be the raw DM channel, NOT the assistant context.
      const stored = await store.getTask(taskId);
      expect(stored).toMatchObject({
        destination: { channelId: "DDM", teamId: TEAM_ID },
        conversationAccess: { audience: "direct", visibility: "private" },
      });
      expect(stored?.credentialMode).toBe("creator");
    } finally {
      await fixture.close();
      vi.restoreAllMocks();
      setPlugins(previous);
    }
  });
});

describe("Slack schedule tool execution modes", () => {
  beforeEach(async () => {
    await initializeSchedulerSqlStore();
  });

  afterEach(async () => {
    await cleanupSchedulerSqlStore();
    vi.restoreAllMocks();
  });

  it("all write tools have executionMode sequential", () => {
    const context = createContext();

    const createTool = createSlackScheduleCreateTaskTool(context);
    const findTool = createSlackScheduleFindTasksTool(context);
    const listTool = createSlackScheduleListTasksTool(context);
    const moveTool = createSlackScheduleMoveTaskTool(context);
    const updateTool = createSlackScheduleUpdateTaskTool(context);
    const deleteTool = createSlackScheduleDeleteTaskTool(context);
    const runNowTool = createSlackScheduleRunTaskNowTool(context);

    // Write tools must force sequential execution so a same-turn
    // slackScheduleListTasks cannot race ahead of a preceding scheduled-task
    // create, update, delete, or move write.
    expect(createTool.executionMode).toBe("sequential");
    expect(moveTool.executionMode).toBe("sequential");
    expect(updateTool.executionMode).toBe("sequential");
    expect(deleteTool.executionMode).toBe("sequential");
    expect(runNowTool.executionMode).toBe("sequential");

    // Find/list are read-only; they inherit the sequential batch gate from any
    // write tool they share a turn with (pi-agent-core makes the whole
    // batch sequential when any tool in it is sequential).
    expect(findTool.executionMode).not.toBe("sequential");
    expect(listTool.executionMode).not.toBe("sequential");
  });
});
