/** Safe structured telemetry attributes for scheduled-task lifecycle events. */
import { logInfo } from "@/chat/logging";
import type { ScheduledRun, ScheduledTask } from "./types";

/** Correlation attributes shared by scheduled-task create and run events. */
export function scheduledTaskAttributes(
  task: Pick<
    ScheduledTask,
    | "id"
    | "conversationAccess"
    | "credentialMode"
    | "destination"
    | "nextRunAtMs"
    | "schedule"
    | "status"
  >,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    "app.task.id": task.id,
    "app.task.type": "scheduled",
    "app.task.status": task.status,
    "app.task.schedule.kind": task.schedule.kind,
    "app.task.schedule.timezone": task.schedule.timezone,
    "app.task.credential_mode": task.credentialMode,
    "app.task.destination.channel_id": task.destination.channelId,
    "app.task.destination.team_id": task.destination.teamId,
    "app.task.destination.visibility": task.conversationAccess.visibility,
    "app.task.destination.audience": task.conversationAccess.audience,
    "messaging.destination.name": task.destination.channelId,
    ...(typeof task.nextRunAtMs === "number"
      ? { "app.task.next_run_at": new Date(task.nextRunAtMs).toISOString() }
      : undefined),
    ...extras,
  };
}

/** Correlation attributes for one scheduled-task run transition. */
export function scheduledTaskRunAttributes(
  task: Pick<
    ScheduledTask,
    | "id"
    | "conversationAccess"
    | "credentialMode"
    | "destination"
    | "nextRunAtMs"
    | "schedule"
    | "status"
  >,
  run: Pick<
    ScheduledRun,
    "id" | "dispatchId" | "scheduledForMs" | "resultMessageTs" | "status"
  >,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return scheduledTaskAttributes(task, {
    "app.task.run.id": run.id,
    "app.task.run.status": run.status,
    "app.task.run.scheduled_for": new Date(run.scheduledForMs).toISOString(),
    ...(run.dispatchId ? { "app.dispatch.id": run.dispatchId } : undefined),
    ...(run.resultMessageTs
      ? { "app.task.result_message_ts": run.resultMessageTs }
      : undefined),
    ...extras,
  });
}

/** Emit the lifecycle event for one skipped scheduled-task run. */
export function logScheduledTaskRunSkipped(
  task: Pick<
    ScheduledTask,
    | "id"
    | "conversationAccess"
    | "credentialMode"
    | "destination"
    | "nextRunAtMs"
    | "schedule"
    | "status"
  >,
  run: Pick<
    ScheduledRun,
    "id" | "dispatchId" | "scheduledForMs" | "resultMessageTs" | "status"
  >,
  extras: Record<string, unknown> = {},
): void {
  logInfo(
    "scheduled_task.run.skipped",
    scheduledTaskRunAttributes(task, run, extras),
  );
}
