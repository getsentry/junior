import {
  type Dispatch,
  type ReplyAttribution,
} from "@sentry/junior-plugin-api";
import {
  dispatchScheduledAutomation,
  getScheduledAutomationDispatch,
} from "@/chat/agent-dispatch/context";
import { getDispatchConversationId } from "@/chat/agent-dispatch/store";
import { renderTaskInput } from "@/chat/task-input";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";
import { getDb } from "@/chat/db";
import { logInfo } from "@/chat/logging";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import type { JuniorDatabase } from "@/db/db";
import {
  advanceScheduledAutomationAfterRun,
  claimDueScheduledRun,
  listIncompleteScheduledRuns,
  markScheduledRunBlocked,
  markScheduledRunCompleted,
  markScheduledRunDispatched,
  markScheduledRunFailed,
  markScheduledRunSkipped,
} from "./runs";
import { readScheduledAutomation } from "./tasks";
import {
  logScheduledAutomationRunSkipped,
  scheduledAutomationRunAttributes,
} from "./telemetry";
import type { ScheduledRun, ScheduledAutomation } from "./types";

const SCHEDULED_AUTOMATION_HEARTBEAT_LIMIT = 10;

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

/** Render the due scheduled automation as plain agent input. */
function buildDispatchInput(task: ScheduledAutomation): string {
  return renderTaskInput({
    instructions: task.task.text,
    outcomes: effectiveTaskOutcomes(task.outcomes, task.destination),
  });
}

function buildDispatchMetadata(args: {
  nowMs: number;
  run: ScheduledRun;
  task: ScheduledAutomation;
}): Record<string, string> {
  if (!args.task.task.text?.trim()) {
    throw new Error("Scheduled automation text is required");
  }
  return {
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
      : undefined),
  };
}

function replyAttribution(task: ScheduledAutomation): ReplyAttribution {
  if (task.schedule.kind === "one_off") {
    return { label: "Scheduled automation", detail: "One-time" };
  }
  const recurrence = task.schedule.recurrence;
  if (!recurrence) {
    return { label: "Scheduled automation", detail: "Recurring" };
  }
  const frequency = SCHEDULE_FREQUENCY_COPY[recurrence.frequency];
  return recurrence.interval === 1
    ? { label: "Scheduled automation", detail: frequency.label }
    : {
        label: "Scheduled automation",
        detail: `Every ${recurrence.interval} ${frequency.unit}s`,
      };
}

function shouldSkipRun(
  task: ScheduledAutomation,
  run: ScheduledRun,
): string | undefined {
  if (task.status === "deleted") {
    return `Scheduled automation ${task.id} was deleted before the run started.`;
  }
  if (task.status !== "active") {
    return `Scheduled automation ${task.id} was ${task.status} before the run started.`;
  }
  if (
    task.nextRunAtMs !== run.scheduledForMs &&
    task.runNowAtMs !== run.scheduledForMs
  ) {
    return `Scheduled automation ${task.id} no longer targets ${new Date(run.scheduledForMs).toISOString()}.`;
  }
  return undefined;
}

async function recordScheduledExecution(args: {
  nowMs: number;
  run: ScheduledRun;
  status: "blocked" | "completed" | "failed";
}): Promise<void> {
  const dispatchId = args.run.dispatchId;
  await recordAutomationExecution("scheduled", args.run.taskId, {
    ...(dispatchId
      ? { conversationId: getDispatchConversationId({ id: dispatchId }) }
      : undefined),
    executionId: args.run.id,
    nowMs: args.nowMs,
    status: args.status,
  });
}

async function logRunOutcome(args: {
  eventName:
    | "scheduled_automation.run.completed"
    | "scheduled_automation.run.failed"
    | "scheduled_automation.run.blocked";
  run: ScheduledRun;
  db: JuniorDatabase;
  /** Prefer a fresh task load after terminal status transitions. */
  task?: ScheduledAutomation;
  extras?: Record<string, unknown>;
}): Promise<void> {
  const task =
    args.task ?? (await readScheduledAutomation(args.db, args.run.taskId));
  if (!task) {
    logInfo(args.eventName, {
      "app.task.id": args.run.taskId,
      "app.task.type": "scheduled",
      "app.task.run.id": args.run.id,
      "app.task.run.status": args.run.status,
      "app.task.run.scheduled_for": new Date(
        args.run.scheduledForMs,
      ).toISOString(),
      ...(args.run.dispatchId
        ? { "app.dispatch.id": args.run.dispatchId }
        : undefined),
      ...(args.run.resultMessageTs
        ? { "app.task.result_message_ts": args.run.resultMessageTs }
        : undefined),
      ...args.extras,
    });
    return;
  }
  logInfo(
    args.eventName,
    scheduledAutomationRunAttributes(task, args.run, args.extras),
  );
}

async function applyDispatchResult(args: {
  dispatch: Dispatch;
  db: JuniorDatabase;
  nowMs: number;
  run: ScheduledRun;
}): Promise<boolean> {
  if (args.dispatch.status === "completed") {
    const completed = await markScheduledRunCompleted(args.db, {
      completedAtMs: args.nowMs,
      resultMessageTs: args.dispatch.resultMessageTs,
      runId: args.run.id,
      startedAtMs: args.run.startedAtMs!,
    });
    if (!completed) return false;
    await advanceScheduledAutomationAfterRun(args.db, {
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
      eventName: "scheduled_automation.run.completed",
      run: completed,
      db: args.db,
    });
    return true;
  }
  if (args.dispatch.status === "blocked") {
    const blocked = await markScheduledRunBlocked(args.db, {
      completedAtMs: args.nowMs,
      errorMessage: args.dispatch.errorMessage ?? "Dispatch blocked.",
      runId: args.run.id,
      startedAtMs: args.run.startedAtMs!,
    });
    if (!blocked) return false;
    await advanceScheduledAutomationAfterRun(args.db, {
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
      eventName: "scheduled_automation.run.blocked",
      run: blocked,
      db: args.db,
      extras: blocked.errorMessage
        ? { "app.task.run.error": blocked.errorMessage }
        : undefined,
    });
    return true;
  }
  if (args.dispatch.status === "failed") {
    const failed = await markScheduledRunFailed(args.db, {
      completedAtMs: args.nowMs,
      errorMessage: args.dispatch.errorMessage ?? "Dispatch failed.",
      runId: args.run.id,
      startedAtMs: args.run.startedAtMs,
    });
    if (!failed) return false;
    await advanceScheduledAutomationAfterRun(args.db, {
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
      eventName: "scheduled_automation.run.failed",
      run: failed,
      db: args.db,
      extras: failed.errorMessage
        ? { "app.task.run.error": failed.errorMessage }
        : undefined,
    });
    return true;
  }
  return false;
}

async function finishClaimedRun(args: {
  db: JuniorDatabase;
  errorMessage: string;
  nowMs: number;
  run: ScheduledRun;
  status: "blocked" | "failed";
}): Promise<void> {
  const finished =
    args.status === "blocked"
      ? await markScheduledRunBlocked(args.db, {
          completedAtMs: args.nowMs,
          errorMessage: args.errorMessage,
          runId: args.run.id,
        })
      : await markScheduledRunFailed(args.db, {
          completedAtMs: args.nowMs,
          errorMessage: args.errorMessage,
          runId: args.run.id,
          startedAtMs: args.run.startedAtMs,
        });
  if (!finished) return;
  await advanceScheduledAutomationAfterRun(args.db, {
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
        ? "scheduled_automation.run.blocked"
        : "scheduled_automation.run.failed",
    run: finished,
    db: args.db,
    extras: { "app.task.run.error": args.errorMessage },
  });
}

/** Reconcile completed dispatches and enqueue a bounded batch of due tasks. */
export async function runScheduledAutomationHeartbeat(args: {
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
}): Promise<number> {
  const db = getDb();
  let processedCount = 0;
  let dispatchCount = 0;
  for (const run of await listIncompleteScheduledRuns(db)) {
    if (!run.dispatchId) continue;
    const dispatch = await getScheduledAutomationDispatch(run.dispatchId);
    if (!dispatch) {
      await finishClaimedRun({
        db,
        errorMessage: "Scheduled automation dispatch record is missing.",
        nowMs: args.nowMs,
        run,
        status: "failed",
      });
      continue;
    }
    if (
      await applyDispatchResult({
        db,
        dispatch,
        nowMs: args.nowMs,
        run,
      })
    ) {
      processedCount += 1;
    }
  }

  for (
    let index = processedCount;
    index < SCHEDULED_AUTOMATION_HEARTBEAT_LIMIT;
    index += 1
  ) {
    const run = await claimDueScheduledRun(db, { nowMs: args.nowMs });
    if (!run) break;
    const task = await readScheduledAutomation(db, run.taskId);
    if (!task) {
      const failed = await markScheduledRunFailed(db, {
        completedAtMs: args.nowMs,
        errorMessage: `Scheduled automation ${run.taskId} was not found`,
        runId: run.id,
      });
      if (failed) {
        await logRunOutcome({
          eventName: "scheduled_automation.run.failed",
          run: failed,
          db,
          extras: {
            "app.task.run.error": `Scheduled automation ${run.taskId} was not found`,
          },
        });
      }
      continue;
    }
    logInfo(
      "scheduled_automation.run.claimed",
      scheduledAutomationRunAttributes(task, run),
    );
    const skippedReason = shouldSkipRun(task, run);
    if (skippedReason) {
      const skipped = await markScheduledRunSkipped(db, {
        completedAtMs: args.nowMs,
        errorMessage: skippedReason,
        runId: run.id,
      });
      if (skipped) {
        logScheduledAutomationRunSkipped(task, skipped, {
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
        db,
        errorMessage:
          error instanceof Error
            ? `Scheduled automation dispatch metadata could not be built: ${error.message}`
            : "Scheduled automation dispatch metadata could not be built.",
        nowMs: args.nowMs,
        run,
        status: "blocked",
      });
      continue;
    }

    let dispatch;
    try {
      dispatch = await dispatchScheduledAutomation({
        conversationWorkQueue: args.conversationWorkQueue,
        nowMs: args.nowMs,
        options: {
          idempotencyKey: run.id,
          ...(task.credentialMode === "creator"
            ? {
                credentialSubject: {
                  type: "user" as const,
                  userId: task.createdBy.slackUserId,
                  allowedWhen: "scheduled-automation" as const,
                  taskId: task.id,
                },
              }
            : undefined),
          destination: task.destination,
          destinationVisibility: task.conversationAccess.visibility,
          input: buildDispatchInput(task),
          metadata,
          replyAttribution: replyAttribution(task),
          outcomes: effectiveTaskOutcomes(task.outcomes, task.destination),
        },
      });
    } catch (error) {
      await finishClaimedRun({
        db,
        errorMessage:
          error instanceof Error
            ? `Scheduled automation dispatch could not be created: ${error.message}`
            : "Scheduled automation dispatch could not be created.",
        nowMs: args.nowMs,
        run,
        status: "blocked",
      });
      continue;
    }
    const dispatched = await markScheduledRunDispatched(db, {
      claimedAtMs: run.claimedAtMs,
      dispatchId: dispatch.id,
      nowMs: args.nowMs,
      runId: run.id,
    });
    logInfo(
      "scheduled_automation.run.dispatched",
      scheduledAutomationRunAttributes(
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
