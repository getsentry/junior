import {
  defineJuniorPlugin,
  type Dispatch,
  type AgentPluginToolDefinition,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { buildScheduledTaskRunPrompt } from "./prompt";
import { createSchedulerStore, type SchedulerStore } from "./store";
import type { ScheduledRun, ScheduledTask } from "./types";
import {
  createSlackScheduleCreateTaskTool,
  createSlackScheduleDeleteTaskTool,
  createSlackScheduleListTasksTool,
  createSlackScheduleRunTaskNowTool,
  createSlackScheduleUpdateTaskTool,
  type SchedulerToolContext,
} from "./schedule-tools";

const SCHEDULER_HEARTBEAT_LIMIT = 10;

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
    channelCapabilities: ctx.channelCapabilities ?? {
      canAddReactions: false,
      canCreateCanvas: false,
      canPostToChannel: false,
    },
    channelId: ctx.channelId,
    messageTs: ctx.messageTs,
    requester: ctx.requester,
    state: ctx.state,
    teamId: ctx.teamId,
    threadTs: ctx.threadTs,
    userText: ctx.userText,
  };
}

async function applyDispatchResult(args: {
  dispatch: Dispatch;
  nowMs: number;
  run: ScheduledRun;
  store: ReturnType<typeof createSchedulerStore>;
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

/** Create Junior's built-in trusted scheduler plugin. */
export function createSchedulerPlugin() {
  return defineJuniorPlugin({
    name: "scheduler",
    pluginConfig: {
      legacyStatePrefixes: ["junior:scheduler"],
      packages: ["@sentry/junior-scheduler"],
    },
    hooks: {
      tools(ctx) {
        if (!ctx.channelId || !ctx.teamId || !ctx.requester?.userId) {
          return {} as Record<string, AgentPluginToolDefinition<any>>;
        }
        const context = createSchedulerToolContext(ctx);
        return {
          slackScheduleCreateTask: createSlackScheduleCreateTaskTool(context),
          slackScheduleListTasks: createSlackScheduleListTasksTool(context),
          slackScheduleUpdateTask: createSlackScheduleUpdateTaskTool(context),
          slackScheduleDeleteTask: createSlackScheduleDeleteTaskTool(context),
          slackScheduleRunTaskNow: createSlackScheduleRunTaskNowTool(context),
        } satisfies Record<string, AgentPluginToolDefinition<any>>;
      },
      async heartbeat(ctx) {
        const store = createSchedulerStore(ctx.state);
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

          let prompt: string;
          try {
            prompt = buildScheduledTaskRunPrompt({
              nowMs: ctx.nowMs,
              run,
              task,
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error
                ? `Scheduled task prompt could not be built: ${error.message}`
                : "Scheduled task prompt could not be built.";
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
              input: prompt,
              metadata: {
                runId: run.id,
                taskId: task.id,
              },
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
    },
  });
}

/** Register trusted scheduler runtime hooks for scheduled Junior tasks. */
export const schedulerPlugin = createSchedulerPlugin;
