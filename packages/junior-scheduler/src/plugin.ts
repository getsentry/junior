import {
  createSlackSource,
  defineJuniorPlugin,
  type Dispatch,
  type PluginToolDefinition,
  type PluginOperationalReportContent,
  type PluginReadState,
  type PluginState,
  type SlackDestination,
  type Source,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import {
  createSchedulerOperationalSqlStore,
  createSchedulerSqlStore,
  migrateSchedulerStateToSql,
  type SchedulerDb,
  type SchedulerOperationalStore,
  type SchedulerStore,
} from "./store";
import {
  sanitizeScheduledTaskPrincipal,
  scheduledTaskPrincipalLabel,
} from "./identity";
import type {
  ScheduledRun,
  ScheduledTask,
  ScheduledTaskPrincipal,
} from "./types";
import {
  createSlackScheduleCreateTaskTool,
  createSlackScheduleDeleteTaskTool,
  createSlackScheduleListTasksTool,
  createSlackScheduleRunTaskNowTool,
  createSlackScheduleUpdateTaskTool,
  type SchedulerToolContext,
} from "./schedule-tools";

const SCHEDULER_HEARTBEAT_LIMIT = 10;
const DASHBOARD_TABLE_LIMIT = 5;

function singleLineMetadataValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildScheduledTaskDispatchMetadata(args: {
  nowMs: number;
  run: ScheduledRun;
  task: ScheduledTask;
}): Record<string, string> {
  const { run, task } = args;
  const creator = sanitizeScheduledTaskPrincipal(task.createdBy);
  if (!task.task.text?.trim()) {
    throw new Error("Scheduled task text is required");
  }

  return {
    creatorSlackUserId: creator.slackUserId,
    runId: run.id,
    schedule: singleLineMetadataValue(task.schedule.description),
    scheduleKind: task.schedule.kind,
    scheduledFor: new Date(run.scheduledForMs).toISOString(),
    runningAt: new Date(args.nowMs).toISOString(),
    taskId: task.id,
    timezone: task.schedule.timezone,
    ...(task.schedule.recurrence
      ? {
          recurrenceFrequency: task.schedule.recurrence.frequency,
          recurrenceInterval: String(task.schedule.recurrence.interval),
          recurrenceStartDate: task.schedule.recurrence.startDate,
        }
      : {}),
  };
}

function scheduledTaskDispatchSource(task: ScheduledTask): Source {
  return createSlackSource({
    teamId: task.destination.teamId,
    channelId: task.destination.channelId,

    type: "priv",
  });
}

function schedulerStore(ctx: { db: unknown }): SchedulerStore {
  return createSchedulerSqlStore(ctx.db as SchedulerDb);
}

function schedulerOperationalStore(ctx: {
  db: unknown;
}): SchedulerOperationalStore {
  return createSchedulerOperationalSqlStore(ctx.db as SchedulerDb);
}

function shouldSkipRun(
  task: ScheduledTask,
  run: ScheduledRun,
): string | undefined {
  if (task.status === "deleted") {
    return `Scheduled task ${task.id} was deleted before the run started.`;
  }
  if (task.status !== "active") {
    return `Scheduled task ${task.id} was ${task.status} before the run started.`;
  }
  if (
    task.nextRunAtMs !== run.scheduledForMs &&
    task.runNowAtMs !== run.scheduledForMs
  ) {
    return `Scheduled task ${task.id} no longer targets ${new Date(run.scheduledForMs).toISOString()}.`;
  }
  return undefined;
}

function createSchedulerToolContext(
  ctx: ToolRegistrationHookContext,
): SchedulerToolContext {
  return {
    credentialSubject: ctx.slack?.credentialSubject,
    source: ctx.source.platform === "slack" ? ctx.source : undefined,
    actor: ctx.actor?.platform === "slack" ? ctx.actor : undefined,
    store: schedulerStore(ctx),
    userText: ctx.userText,
  };
}

async function applyDispatchResult(args: {
  dispatch: Dispatch;
  nowMs: number;
  run: ScheduledRun;
  store: SchedulerStore;
}): Promise<boolean> {
  if (args.dispatch.status === "completed") {
    const completed = await args.store.markRunCompleted({
      completedAtMs: args.nowMs,
      resultMessageTs: args.dispatch.resultMessageTs,
      runId: args.run.id,
      startedAtMs: args.run.startedAtMs!,
    });
    if (!completed) {
      return false;
    }
    await args.store.updateTaskAfterRun({
      nowMs: args.nowMs,
      run: args.run,
      status: "completed",
    });
    return true;
  }

  if (args.dispatch.status === "blocked") {
    const blocked = await args.store.markRunBlocked({
      completedAtMs: args.nowMs,
      errorMessage: args.dispatch.errorMessage ?? "Dispatch blocked.",
      runId: args.run.id,
      startedAtMs: args.run.startedAtMs!,
    });
    if (!blocked) {
      return false;
    }
    await args.store.updateTaskAfterRun({
      errorMessage: blocked.errorMessage,
      nowMs: args.nowMs,
      run: args.run,
      status: "blocked",
    });
    return true;
  }

  if (args.dispatch.status === "failed") {
    const failed = await args.store.markRunFailed({
      completedAtMs: args.nowMs,
      errorMessage: args.dispatch.errorMessage ?? "Dispatch failed.",
      runId: args.run.id,
      startedAtMs: args.run.startedAtMs,
    });
    if (!failed) {
      return false;
    }
    await args.store.updateTaskAfterRun({
      errorMessage: failed.errorMessage,
      nowMs: args.nowMs,
      run: args.run,
      status: "failed",
    });
    return true;
  }

  return false;
}

async function blockClaimedRun(args: {
  errorMessage: string;
  nowMs: number;
  run: ScheduledRun;
  store: SchedulerStore;
}): Promise<void> {
  const blocked = await args.store.markRunBlocked({
    completedAtMs: args.nowMs,
    errorMessage: args.errorMessage,
    runId: args.run.id,
  });
  if (!blocked) {
    return;
  }
  await args.store.updateTaskAfterRun({
    errorMessage: args.errorMessage,
    nowMs: args.nowMs,
    run: args.run,
    status: "blocked",
  });
}

async function failClaimedRun(args: {
  errorMessage: string;
  nowMs: number;
  run: ScheduledRun;
  store: SchedulerStore;
}): Promise<void> {
  const failed = await args.store.markRunFailed({
    completedAtMs: args.nowMs,
    errorMessage: args.errorMessage,
    runId: args.run.id,
    startedAtMs: args.run.startedAtMs,
  });
  if (!failed) {
    return;
  }
  await args.store.updateTaskAfterRun({
    errorMessage: args.errorMessage,
    nowMs: args.nowMs,
    run: args.run,
    status: "failed",
  });
}

function formatCount(value: number): string {
  return String(value);
}

function formatTimestamp(timestampMs: number | undefined): string {
  return typeof timestampMs === "number" && Number.isFinite(timestampMs)
    ? new Date(timestampMs).toISOString()
    : "none";
}

function destinationLabel(destination: SlackDestination): string {
  if (destination.channelId.startsWith("D")) {
    return "Direct Message";
  }
  if (destination.channelId.startsWith("C")) {
    return `Public Channel ${destination.channelId}`;
  }
  if (destination.channelId.startsWith("G")) {
    return `Private Destination ${destination.channelId}`;
  }
  return destination.channelId;
}

function operationalAuthorLabel(author: ScheduledTaskPrincipal): string {
  try {
    return scheduledTaskPrincipalLabel(author);
  } catch {
    return "Invalid Slack creator metadata";
  }
}

function cadenceLabel(task: ScheduledTask): string {
  if (task.schedule.kind === "one_off") {
    return "one-off";
  }
  return task.schedule.recurrence
    ? task.schedule.recurrence.frequency
    : "recurring";
}

function taskStatusCounts(tasks: ScheduledTask[]) {
  return tasks.reduce(
    (counts, task) => ({
      active: counts.active + (task.status === "active" ? 1 : 0),
      blocked: counts.blocked + (task.status === "blocked" ? 1 : 0),
      paused: counts.paused + (task.status === "paused" ? 1 : 0),
    }),
    { active: 0, blocked: 0, paused: 0 },
  );
}

function isDue(task: ScheduledTask, nowMs: number): boolean {
  return (
    task.status === "active" &&
    ((typeof task.runNowAtMs === "number" && task.runNowAtMs <= nowMs) ||
      (typeof task.nextRunAtMs === "number" && task.nextRunAtMs <= nowMs))
  );
}

async function buildSchedulerOperationalReport(args: {
  nowMs: number;
  store: SchedulerOperationalStore;
}): Promise<PluginOperationalReportContent> {
  const tasks = await args.store.listTasks();
  const incompleteRuns = await args.store.listIncompleteRunsForTasks(tasks);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const counts = taskStatusCounts(tasks);
  const dueCount = tasks.filter((task) => isDue(task, args.nowMs)).length;
  const upcomingTasks = tasks
    .filter((task) => task.status === "active" && task.nextRunAtMs)
    .sort((left, right) => left.nextRunAtMs! - right.nextRunAtMs!)
    .slice(0, DASHBOARD_TABLE_LIMIT);
  const blockedTasks = tasks
    .filter((task) => task.status === "blocked")
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, DASHBOARD_TABLE_LIMIT);
  const runningCount = incompleteRuns.length;
  const runningRuns = incompleteRuns
    .sort((left, right) => right.claimedAtMs - left.claimedAtMs)
    .slice(0, DASHBOARD_TABLE_LIMIT);

  return {
    title: "Scheduler",
    generatedAt: new Date(args.nowMs).toISOString(),
    metrics: [
      {
        label: "active",
        tone: counts.active > 0 ? "good" : "neutral",
        value: formatCount(counts.active),
      },
      {
        label: "blocked",
        tone: counts.blocked > 0 ? "danger" : "neutral",
        value: formatCount(counts.blocked),
      },
      { label: "paused", value: formatCount(counts.paused) },
      {
        label: "due now",
        tone: dueCount > 0 ? "warning" : "neutral",
        value: formatCount(dueCount),
      },
      {
        label: "running",
        tone: runningCount > 0 ? "warning" : "neutral",
        value: formatCount(runningCount),
      },
    ],
    recordSets: [
      {
        title: "Upcoming",
        emptyText: "No active scheduled tasks.",
        fields: [
          { key: "task", label: "Task" },
          { key: "author", label: "Author" },
          { key: "destination", label: "Destination" },
          { key: "nextRun", label: "Next Run" },
          { key: "cadence", label: "Cadence" },
        ],
        records: upcomingTasks.map((task) => ({
          id: task.id,
          values: {
            task: task.id,
            author: operationalAuthorLabel(task.createdBy),
            destination: destinationLabel(task.destination),
            nextRun: formatTimestamp(task.nextRunAtMs),
            cadence: cadenceLabel(task),
          },
        })),
      },
      {
        title: "Blocked",
        emptyText: "No blocked scheduled tasks.",
        fields: [
          { key: "task", label: "Task" },
          { key: "author", label: "Author" },
          { key: "destination", label: "Destination" },
          { key: "updated", label: "Updated" },
        ],
        records: blockedTasks.map((task) => ({
          id: task.id,
          tone: "danger",
          values: {
            task: task.id,
            author: operationalAuthorLabel(task.createdBy),
            destination: destinationLabel(task.destination),
            updated: formatTimestamp(task.updatedAtMs),
          },
        })),
      },
      {
        title: "Running",
        emptyText: "No scheduler runs in flight.",
        fields: [
          { key: "run", label: "Run" },
          { key: "task", label: "Task" },
          { key: "author", label: "Author" },
          { key: "scheduledFor", label: "Scheduled For" },
          { key: "status", label: "Status" },
        ],
        records: runningRuns.map((run) => {
          const task = taskById.get(run.taskId);
          return {
            id: run.id,
            tone: run.status === "pending" ? "warning" : "neutral",
            values: {
              run: run.id,
              task: run.taskId,
              author: task
                ? operationalAuthorLabel(task.createdBy)
                : "Missing scheduled task",
              scheduledFor: formatTimestamp(run.scheduledForMs),
              status: run.status,
            },
          };
        }),
      },
    ],
  };
}

/** Create Junior's built-in trusted scheduler plugin. */
export function createSchedulerPlugin() {
  return defineJuniorPlugin({
    manifest: {
      name: "scheduler",
      displayName: "Scheduler",
      description: "Scheduled Junior task management and heartbeat dispatch",
    },
    packageName: "@sentry/junior-scheduler",
    hooks: {
      tools(ctx) {
        if (
          ctx.source.platform !== "slack" ||
          ctx.actor?.platform !== "slack"
        ) {
          return {} as Record<string, PluginToolDefinition>;
        }
        const context = createSchedulerToolContext(ctx);
        return {
          slackScheduleCreateTask: createSlackScheduleCreateTaskTool(context),
          slackScheduleListTasks: createSlackScheduleListTasksTool(context),
          slackScheduleUpdateTask: createSlackScheduleUpdateTaskTool(context),
          slackScheduleDeleteTask: createSlackScheduleDeleteTaskTool(context),
          slackScheduleRunTaskNow: createSlackScheduleRunTaskNowTool(context),
        } satisfies Record<string, PluginToolDefinition>;
      },
      async heartbeat(ctx) {
        const store = schedulerStore(ctx);
        let processedCount = 0;
        let dispatchCount = 0;
        for (const run of await store.listIncompleteRuns()) {
          if (!run.dispatchId) {
            continue;
          }
          const dispatch = await ctx.agent.get(run.dispatchId);
          if (!dispatch) {
            await failClaimedRun({
              errorMessage: "Scheduled task dispatch record is missing.",
              nowMs: ctx.nowMs,
              run,
              store,
            });
            continue;
          }
          if (
            await applyDispatchResult({
              dispatch,
              nowMs: ctx.nowMs,
              run,
              store,
            })
          ) {
            processedCount += 1;
          }
        }

        for (
          let index = processedCount;
          index < SCHEDULER_HEARTBEAT_LIMIT;
          index += 1
        ) {
          const run = await store.claimDueRun({ nowMs: ctx.nowMs });
          if (!run) {
            break;
          }
          const task = await store.getTask(run.taskId);
          if (!task) {
            await store.markRunFailed({
              completedAtMs: ctx.nowMs,
              errorMessage: `Scheduled task ${run.taskId} was not found`,
              runId: run.id,
            });
            continue;
          }
          const skippedReason = shouldSkipRun(task, run);
          if (skippedReason) {
            await store.markRunSkipped({
              completedAtMs: ctx.nowMs,
              errorMessage: skippedReason,
              runId: run.id,
            });
            continue;
          }

          let dispatchMetadata: Record<string, string>;
          try {
            dispatchMetadata = buildScheduledTaskDispatchMetadata({
              nowMs: ctx.nowMs,
              run,
              task,
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error
                ? `Scheduled task dispatch metadata could not be built: ${error.message}`
                : "Scheduled task dispatch metadata could not be built.";
            await blockClaimedRun({
              errorMessage,
              nowMs: ctx.nowMs,
              run,
              store,
            });
            continue;
          }
          let dispatch: Awaited<ReturnType<typeof ctx.agent.dispatch>>;
          try {
            dispatch = await ctx.agent.dispatch({
              idempotencyKey: run.id,
              ...(task.credentialSubject
                ? { credentialSubject: task.credentialSubject }
                : {}),
              destination: task.destination,
              input: task.task.text,
              metadata: dispatchMetadata,
              source: scheduledTaskDispatchSource(task),
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error
                ? `Scheduled task dispatch could not be created: ${error.message}`
                : "Scheduled task dispatch could not be created.";
            await blockClaimedRun({
              errorMessage,
              nowMs: ctx.nowMs,
              run,
              store,
            });
            continue;
          }
          await store.markRunDispatched({
            claimedAtMs: run.claimedAtMs,
            dispatchId: dispatch.id,
            nowMs: ctx.nowMs,
            runId: run.id,
          });
          dispatchCount += 1;
        }

        return { dispatchCount };
      },
      async operationalReport(ctx) {
        return buildSchedulerOperationalReport({
          nowMs: ctx.nowMs,
          store: schedulerOperationalStore(ctx),
        });
      },
      async migrateStorage(ctx) {
        return await migrateSchedulerStateToSql({
          db: ctx.db as SchedulerDb,
          state: ctx.state,
        });
      },
    },
  });
}

/** Register scheduler runtime hooks for scheduled Junior tasks. */
export const schedulerPlugin = createSchedulerPlugin;
