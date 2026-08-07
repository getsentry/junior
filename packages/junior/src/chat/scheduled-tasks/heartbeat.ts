import {
  createSlackSource,
  type Dispatch,
  type ReplyAttribution,
  type Source,
} from "@sentry/junior-plugin-api";
import {
  dispatchScheduledTask,
  getScheduledTaskDispatch,
} from "@/chat/agent-dispatch/context";
import { getDispatchConversationId } from "@/chat/agent-dispatch/store";
import { getDb } from "@/chat/db";
import { logInfo } from "@/chat/logging";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { recordTaskExecution } from "@/chat/tasks/execution-stats";
import { sanitizeScheduledTaskPrincipal } from "./identity";
import { createSchedulerSqlStore, type SchedulerStore } from "./store";
import {
  logScheduledTaskRunSkipped,
  scheduledTaskRunAttributes,
} from "./telemetry";
import type { ScheduledRun, ScheduledTask } from "./types";

const SCHEDULED_TASK_HEARTBEAT_LIMIT = 10;

const SCHEDULE_FREQUENCY_COPY = {
  daily: { label: "Daily", unit: "day" },
  weekly: { label: "Weekly", unit: "week" },
  monthly: { label: "Monthly", unit: "month" },
  yearly: { label: "Yearly", unit: "year" },
} as const;

function singleLineMetadataValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDispatchMetadata(args: {
  nowMs: number;
  run: ScheduledRun;
  task: ScheduledTask;
}): Record<string, string> {
  const creator = sanitizeScheduledTaskPrincipal(args.task.createdBy);
  if (!args.task.task.text?.trim()) {
    throw new Error("Scheduled task text is required");
  }
  return {
    creatorSlackUserId: creator.slackUserId,
    runId: args.run.id,
    schedule: singleLineMetadataValue(args.task.schedule.description),
    scheduleKind: args.task.schedule.kind,
    scheduledFor: new Date(args.run.scheduledForMs).toISOString(),
    runningAt: new Date(args.nowMs).toISOString(),
    taskId: args.task.id,
    timezone: args.task.schedule.timezone,
    ...(args.task.schedule.recurrence
      ? {
          recurrenceFrequency: args.task.schedule.recurrence.frequency,
          recurrenceInterval: String(args.task.schedule.recurrence.interval),
          recurrenceStartDate: args.task.schedule.recurrence.startDate,
        }
      : {}),
  };
}

function replyAttribution(task: ScheduledTask): ReplyAttribution {
  if (task.schedule.kind === "one_off") {
    return { label: "Scheduled task", detail: "One-time" };
  }
  const recurrence = task.schedule.recurrence;
  if (!recurrence) {
    return { label: "Scheduled task", detail: "Recurring" };
  }
  const frequency = SCHEDULE_FREQUENCY_COPY[recurrence.frequency];
  return recurrence.interval === 1
    ? { label: "Scheduled task", detail: frequency.label }
    : {
        label: "Scheduled task",
        detail: `Every ${recurrence.interval} ${frequency.unit}s`,
      };
}

function dispatchSource(task: ScheduledTask): Source {
  return createSlackSource({
    teamId: task.destination.teamId,
    channelId: task.destination.channelId,
    visibility: task.conversationAccess.visibility,
  });
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

async function recordScheduledExecution(args: {
  nowMs: number;
  run: ScheduledRun;
  status: "blocked" | "completed" | "failed";
}): Promise<void> {
  const dispatchId = args.run.dispatchId;
  await recordTaskExecution("scheduled", args.run.taskId, {
    ...(dispatchId
      ? { conversationId: getDispatchConversationId({ id: dispatchId }) }
      : {}),
    executionId: args.run.id,
    nowMs: args.nowMs,
    status: args.status,
  });
}

async function logRunOutcome(args: {
  eventName:
    | "scheduled_task.run.completed"
    | "scheduled_task.run.failed"
    | "scheduled_task.run.blocked";
  run: ScheduledRun;
  store: SchedulerStore;
  /** Prefer a fresh task load after terminal status transitions. */
  task?: ScheduledTask;
  extras?: Record<string, unknown>;
}): Promise<void> {
  const task =
    args.task ?? (await args.store.getTask(args.run.taskId)) ?? undefined;
  if (!task) {
    logInfo(args.eventName, {
      "app.task.id": args.run.taskId,
      "app.task.type": "scheduled",
      "app.task.run.id": args.run.id,
      "app.task.run.status": args.run.status,
      "app.task.run.scheduled_for": new Date(
        args.run.scheduledForMs,
      ).toISOString(),
      ...(args.run.dispatchId ? { "app.dispatch.id": args.run.dispatchId } : {}),
      ...(args.run.resultMessageTs
        ? { "app.task.result_message_ts": args.run.resultMessageTs }
        : {}),
      ...args.extras,
    });
    return;
  }
  logInfo(
    args.eventName,
    scheduledTaskRunAttributes(task, args.run, args.extras),
  );
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
    if (!completed) return false;
    await args.store.updateTaskAfterRun({
      nowMs: args.nowMs,
      run: args.run,
      status: "completed",
    });
    await recordScheduledExecution({
      nowMs: args.nowMs,
      run: args.run,
      status: "completed",
    });
    await logRunOutcome({
      eventName: "scheduled_task.run.completed",
      run: completed,
      store: args.store,
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
    if (!blocked) return false;
    await args.store.updateTaskAfterRun({
      errorMessage: blocked.errorMessage,
      nowMs: args.nowMs,
      run: args.run,
      status: "blocked",
    });
    await recordScheduledExecution({
      nowMs: args.nowMs,
      run: args.run,
      status: "blocked",
    });
    await logRunOutcome({
      eventName: "scheduled_task.run.blocked",
      run: blocked,
      store: args.store,
      extras: blocked.errorMessage
        ? { "app.task.run.error": blocked.errorMessage }
        : undefined,
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
    if (!failed) return false;
    await args.store.updateTaskAfterRun({
      errorMessage: failed.errorMessage,
      nowMs: args.nowMs,
      run: args.run,
      status: "failed",
    });
    await recordScheduledExecution({
      nowMs: args.nowMs,
      run: args.run,
      status: "failed",
    });
    await logRunOutcome({
      eventName: "scheduled_task.run.failed",
      run: failed,
      store: args.store,
      extras: failed.errorMessage
        ? { "app.task.run.error": failed.errorMessage }
        : undefined,
    });
    return true;
  }
  return false;
}

async function finishClaimedRun(args: {
  errorMessage: string;
  nowMs: number;
  run: ScheduledRun;
  status: "blocked" | "failed";
  store: SchedulerStore;
}): Promise<void> {
  const finished =
    args.status === "blocked"
      ? await args.store.markRunBlocked({
          completedAtMs: args.nowMs,
          errorMessage: args.errorMessage,
          runId: args.run.id,
        })
      : await args.store.markRunFailed({
          completedAtMs: args.nowMs,
          errorMessage: args.errorMessage,
          runId: args.run.id,
          startedAtMs: args.run.startedAtMs,
        });
  if (!finished) return;
  await args.store.updateTaskAfterRun({
    errorMessage: args.errorMessage,
    nowMs: args.nowMs,
    run: args.run,
    status: args.status,
  });
  await recordScheduledExecution({
    nowMs: args.nowMs,
    run: args.run,
    status: args.status,
  });
  await logRunOutcome({
    eventName:
      args.status === "blocked"
        ? "scheduled_task.run.blocked"
        : "scheduled_task.run.failed",
    run: finished,
    store: args.store,
    extras: { "app.task.run.error": args.errorMessage },
  });
}

/** Reconcile completed dispatches and enqueue a bounded batch of due tasks. */
export async function runScheduledTaskHeartbeat(args: {
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
}): Promise<number> {
  const store = createSchedulerSqlStore(getDb());
  let processedCount = 0;
  let dispatchCount = 0;
  for (const run of await store.listIncompleteRuns()) {
    if (!run.dispatchId) continue;
    const dispatch = await getScheduledTaskDispatch(run.dispatchId);
    if (!dispatch) {
      await finishClaimedRun({
        errorMessage: "Scheduled task dispatch record is missing.",
        nowMs: args.nowMs,
        run,
        status: "failed",
        store,
      });
      continue;
    }
    if (
      await applyDispatchResult({
        dispatch,
        nowMs: args.nowMs,
        run,
        store,
      })
    ) {
      processedCount += 1;
    }
  }

  for (
    let index = processedCount;
    index < SCHEDULED_TASK_HEARTBEAT_LIMIT;
    index += 1
  ) {
    const run = await store.claimDueRun({ nowMs: args.nowMs });
    if (!run) break;
    const task = await store.getTask(run.taskId);
    if (!task) {
      const failed = await store.markRunFailed({
        completedAtMs: args.nowMs,
        errorMessage: `Scheduled task ${run.taskId} was not found`,
        runId: run.id,
      });
      if (failed) {
        await logRunOutcome({
          eventName: "scheduled_task.run.failed",
          run: failed,
          store,
          extras: {
            "app.task.run.error": `Scheduled task ${run.taskId} was not found`,
          },
        });
      }
      continue;
    }
    logInfo(
      "scheduled_task.run.claimed",
      scheduledTaskRunAttributes(task, run),
    );
    const skippedReason = shouldSkipRun(task, run);
    if (skippedReason) {
      const skipped = await store.markRunSkipped({
        completedAtMs: args.nowMs,
        errorMessage: skippedReason,
        runId: run.id,
      });
      if (skipped) {
        logScheduledTaskRunSkipped(task, skipped, {
          "app.task.run.error": skippedReason,
        });
      }
      continue;
    }

    let metadata: Record<string, string>;
    try {
      metadata = buildDispatchMetadata({ nowMs: args.nowMs, run, task });
    } catch (error) {
      await finishClaimedRun({
        errorMessage:
          error instanceof Error
            ? `Scheduled task dispatch metadata could not be built: ${error.message}`
            : "Scheduled task dispatch metadata could not be built.",
        nowMs: args.nowMs,
        run,
        status: "blocked",
        store,
      });
      continue;
    }

    let dispatch;
    try {
      dispatch = await dispatchScheduledTask({
        conversationWorkQueue: args.conversationWorkQueue,
        nowMs: args.nowMs,
        options: {
          idempotencyKey: run.id,
          ...(task.credentialMode === "creator"
            ? {
                credentialSubject: {
                  type: "user" as const,
                  userId: task.createdBy.slackUserId,
                  allowedWhen: "scheduled-task" as const,
                  taskId: task.id,
                },
              }
            : {}),
          destination: task.destination,
          destinationVisibility: task.conversationAccess.visibility,
          input: task.task.text,
          metadata,
          replyAttribution: replyAttribution(task),
          source: dispatchSource(task),
        },
      });
    } catch (error) {
      await finishClaimedRun({
        errorMessage:
          error instanceof Error
            ? `Scheduled task dispatch could not be created: ${error.message}`
            : "Scheduled task dispatch could not be created.",
        nowMs: args.nowMs,
        run,
        status: "blocked",
        store,
      });
      continue;
    }
    const dispatched = await store.markRunDispatched({
      claimedAtMs: run.claimedAtMs,
      dispatchId: dispatch.id,
      nowMs: args.nowMs,
      runId: run.id,
    });
    logInfo(
      "scheduled_task.run.dispatched",
      scheduledTaskRunAttributes(
        task,
        dispatched ?? { ...run, dispatchId: dispatch.id },
        {
          "app.dispatch.id": dispatch.id,
        },
      ),
    );
    dispatchCount += 1;
  }
  return dispatchCount;
}
