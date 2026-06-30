import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  PluginToolInputError,
  type PluginToolDefinition,
} from "@sentry/junior-plugin-api";
import {
  createSchedulerSqlStore,
  createSlackScheduleCreateTaskTool,
  createSlackScheduleDeleteTaskTool,
  createSlackScheduleListTasksTool,
  createSlackScheduleRunTaskNowTool,
  createSlackScheduleUpdateTaskTool,
  type ScheduledTask,
  type SchedulerDb,
  type SchedulerToolContext,
} from "@sentry/junior-scheduler";
import { createSlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { migratePluginSchemas, readPluginMigrations } from "@/chat/plugins/db";
import * as dbModule from "@/chat/db";
import { getPluginTools, setPlugins } from "@/chat/plugins/agent-hooks";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { schedulerPlugin } from "@sentry/junior-scheduler";
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

function schedulerMigrationsDir(): string {
  return path.resolve(process.cwd(), "../junior-scheduler/migrations");
}

async function useSchedulerSqlPlugin() {
  const fixture = await createLocalJuniorSqlFixture();
  await migratePluginSchemas(
    fixture.sql,
    readPluginMigrations({
      dir: schedulerMigrationsDir(),
      pluginName: "scheduler",
    }),
  );
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
    teamId?: string;
  } = {},
): SchedulerToolContext {
  const channelId = overrides.channelId ?? "C123";
  const teamId = overrides.teamId ?? TEST_TEAM_ID;
  const contextOverrides = { ...overrides };
  delete contextOverrides.channelId;
  delete contextOverrides.teamId;
  const context: SchedulerToolContext = {
    source: createSlackSource({
      teamId,
      channelId,
    }),
    requester: {
      platform: "slack",
      teamId,
      userId: "U123",
      userName: "dcramer",
      fullName: "David Cramer",
    },
    userText: "schedule this weekly",
    store: schedulerStore(),
    ...contextOverrides,
  };
  const credentialSubject =
    context.credentialSubject ??
    createSlackDirectCredentialSubject({
      channelId: context.source?.channelId,
      teamId: context.source?.teamId,
      userId: context.requester?.userId,
    });
  return {
    ...context,
    ...(credentialSubject ? { credentialSubject } : {}),
  };
}

async function executeTool<TInput>(
  tool: PluginToolDefinition<TInput>,
  input: TInput,
) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {});
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
    schedule: "Every Monday at 9am",
    schedule_kind: "recurring",
    timezone: "America/Los_Angeles",
    next_run_at: "2026-05-25T16:00:00.000Z",
    recurrence: "weekly",
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

  it("exposes schedule kind as a required create schema field", async () => {
    const schema = createSlackScheduleCreateTaskTool(createContext())
      .inputSchema as {
      properties?: Record<
        string,
        {
          anyOf?: Array<{ const?: unknown }>;
          oneOf?: Array<{ const?: unknown }>;
        }
      >;
      required?: string[];
    };
    const scheduleKind = schema.properties?.schedule_kind;
    const options = (scheduleKind?.anyOf ?? scheduleKind?.oneOf ?? [])
      .map((option) => option.const)
      .sort();

    expect(schema.required).toContain("schedule_kind");
    expect(options).toEqual(["one_off", "recurring"]);
  });

  it("creates and lists tasks only for the active Slack conversation", async () => {
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
      createSlackScheduleListTasksTool(createContext()),
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
        schedule_kind: "recurring",
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

  it("does not store Slack ids as creator display identity", async () => {
    const created = (await createTask(
      createContext({
        requester: {
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

  it("rejects synthetic unknown requester ids before creating a task", async () => {
    const rejected = createTask(
      createContext({
        requester: {
          platform: "slack",
          teamId: TEST_TEAM_ID,
          userId: "unknown",
          userName: "unknown",
          fullName: "unknown",
        },
      }),
    );

    await expect(rejected).rejects.toThrow(PluginToolInputError);
    await expect(rejected).rejects.toThrow(
      "No active Slack requester context is available.",
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
        schedule: "In 1 minute",
        schedule_kind: "one_off",
        next_run_at: "2026-05-27T00:25:23.000Z",
      },
    );

    await expect(rejected).rejects.toThrow(PluginToolInputError);
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

  it("rejects invalid Slack credential subject context before creating a task", async () => {
    const rejected = createTask(
      createContext({
        channelId: "D123",
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
          binding: {
            type: "slack-direct-conversation",
            teamId: TEST_TEAM_ID,
            channelId: "D123",
            signature: "v1=test",
          },
        } as SchedulerToolContext["credentialSubject"],
      }),
    );

    await expect(rejected).rejects.toThrow(PluginToolInputError);
    await expect(rejected).rejects.toThrow(
      "Active Slack credential subject is invalid.",
    );
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
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
          teamId: "D_BAD_TEAM",
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
        id: "sched_bad_credential_subject",
        destination: {
          platform: "slack",
          teamId: TEST_TEAM_ID,
          channelId: "D123",
        },
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
          binding: {
            type: "slack-direct-conversation",
            teamId: TEST_TEAM_ID,
            channelId: "D123",
            signature: "v1=test",
          },
        } as ScheduledTask["credentialSubject"],
      }),
    ).rejects.toThrow("Scheduled task routing context is invalid.");
    await expect(
      schedulerStore().getTask("sched_bad_credential_subject"),
    ).resolves.toBe(undefined);
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
        schedule_kind: "one_off",
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
        schedule_kind: "one_off",
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
        schedule_kind: "one_off",
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

  it("rejects create calls that omit schedule kind", async () => {
    await expect(
      createTask(createContext(), {
        schedule_kind: undefined,
      }),
    ).rejects.toThrow("Provide schedule_kind as one_off or recurring.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects one-off create calls that include recurrence", async () => {
    await expect(
      createTask(createContext(), {
        schedule: "In 30 seconds",
        schedule_kind: "one_off",
        recurrence: "daily",
      }),
    ).rejects.toThrow("Omit recurrence when schedule_kind is one_off.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("rejects recurring create calls that omit recurrence", async () => {
    await expect(
      createTask(createContext(), {
        schedule_kind: "recurring",
        recurrence: undefined,
      }),
    ).rejects.toThrow("Provide recurrence when schedule_kind is recurring.");
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
      ok: true,
      tasks: [{ id: taskId }],
    });

    const deleted = await executeTool(
      createSlackScheduleDeleteTaskTool(createContext({ channelId: "DDM" })),
      { task_id: taskId },
    );
    expect(deleted).toMatchObject({
      ok: true,
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
            }),
            teamId: TEST_TEAM_ID,
            channelId: "slack:D123:1700000000.000",
          },
        },
        {
          schedule: "In 1 minute",
          schedule_kind: "one_off",
          next_run_at: "2026-05-27T00:25:23.000Z",
          recurrence: undefined,
        },
      ),
    ).rejects.toThrow("Active Slack conversation channel is invalid.");
    await expect(
      schedulerStore().listTasksForTeam(TEST_TEAM_ID),
    ).resolves.toEqual([]);
  });

  it("stores canonical Slack destinations directly", async () => {
    const result = await createTask(createContext({ channelId: "D123" }), {
      schedule: "In 1 minute",
      schedule_kind: "one_off",
      next_run_at: "2026-05-27T00:25:23.000Z",
      recurrence: undefined,
    });

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
      schedule_kind: "one_off",
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
      schedule_kind: "one_off",
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

describe("Slack schedule tool wiring via getPluginTools", () => {
  // These tests exercise the real agent-hooks.ts path where the runtime-owned
  // Destination is passed through to the scheduler plugin.

  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("scheduler tools bind to the runtime-owned source", async () => {
    // Verifies that real getPluginTools wiring passes Source through to
    // the scheduler, which stores it as the task destination.
    const previous = setPlugins([schedulerPlugin()]);
    const { fixture, store } = await useSchedulerSqlPlugin();
    try {
      const TEAM_ID = `TWIRING${Date.now()}`;
      const tools = getPluginTools({
        source: createSlackSource({
          teamId: TEAM_ID,
          channelId: "DDM",
        }),
        destination: {
          platform: "slack",
          teamId: TEAM_ID,
          channelId: "DDM",
        },
        requester: {
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
        sandbox: {} as Parameters<typeof getPluginTools>[0]["sandbox"],
      });

      expect(tools).toHaveProperty("scheduler_slackScheduleCreateTask");

      // Create a task through the real wired tool.
      const result = await executeTool(
        tools.scheduler_slackScheduleCreateTask,
        {
          task: "Wiring test: post a weekly digest.",
          schedule: "Every Monday at 9am",
          schedule_kind: "recurring",
          timezone: "America/Los_Angeles",
          next_run_at: "2026-06-09T16:00:00.000Z",
          recurrence: "weekly",
        },
      );

      expect(result).toMatchObject({ ok: true });
      const taskId = (result as { task: { id: string } }).task.id;

      // Task destination must be the raw DM channel, NOT the assistant context.
      const stored = await store.getTask(taskId);
      expect(stored).toMatchObject({
        destination: { channelId: "DDM", teamId: TEAM_ID },
        conversationAccess: { audience: "direct", visibility: "private" },
      });
      // DM-based task gets a credential subject (private-direct exception).
      expect(stored?.credentialSubject).toMatchObject({
        type: "user",
        userId: "U123",
        allowedWhen: "private-direct-conversation",
      });
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
    const listTool = createSlackScheduleListTasksTool(context);
    const updateTool = createSlackScheduleUpdateTaskTool(context);
    const deleteTool = createSlackScheduleDeleteTaskTool(context);
    const runNowTool = createSlackScheduleRunTaskNowTool(context);

    // Write tools must force sequential execution so a same-turn
    // scheduler_slackScheduleListTasks call cannot race ahead of a preceding
    // scheduler_slackScheduleCreateTask / update / delete write.
    expect(createTool.executionMode).toBe("sequential");
    expect(updateTool.executionMode).toBe("sequential");
    expect(deleteTool.executionMode).toBe("sequential");
    expect(runNowTool.executionMode).toBe("sequential");

    // List is read-only; it inherits the sequential batch gate from any
    // write tool it shares a turn with (pi-agent-core makes the whole
    // batch sequential when any tool in it is sequential).
    expect(listTool.executionMode).not.toBe("sequential");
  });
});
