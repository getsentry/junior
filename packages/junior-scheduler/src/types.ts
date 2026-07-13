import type { SlackDestination, SystemActor } from "@sentry/junior-plugin-api";
import { z } from "zod";

export type ScheduledTaskStatus = "active" | "paused" | "blocked" | "deleted";
export const scheduledTaskCredentialModeSchema = z.enum(["system", "creator"]);
export type ScheduledTaskCredentialMode = z.infer<
  typeof scheduledTaskCredentialModeSchema
>;

export type ScheduledRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";

export interface ScheduledTaskPrincipal {
  slackUserId: string;
  fullName?: string;
  userName?: string;
}

export type ScheduledTaskExecutionActor = SystemActor;

export const SCHEDULED_TASK_SYSTEM_ACTOR = Object.freeze({
  platform: "system",
  name: "scheduled-task",
} satisfies ScheduledTaskExecutionActor);

export interface ScheduledTaskConversationAccess {
  audience: "direct" | "group" | "channel";
  visibility: "private" | "public" | "unknown";
}

export type ScheduledCalendarFrequency =
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly";

export interface ScheduledLocalTime {
  hour: number;
  minute: number;
}

export interface ScheduledTaskRecurrence {
  dayOfMonth?: number;
  frequency: ScheduledCalendarFrequency;
  interval: number;
  month?: number;
  startDate: string;
  time: ScheduledLocalTime;
  weekdays?: number[];
}

export interface ScheduledTaskSchedule {
  description: string;
  timezone: string;
  kind: "one_off" | "recurring";
  recurrence?: ScheduledTaskRecurrence;
}

export interface ScheduledTaskSpec {
  text: string;
}

export interface ScheduledTask {
  id: string;
  createdAtMs: number;
  createdBy: ScheduledTaskPrincipal;
  conversationAccess?: ScheduledTaskConversationAccess;
  /** Selects system credentials or explicitly delegated creator credentials. */
  credentialMode: ScheduledTaskCredentialMode;
  destination: SlackDestination;
  executionActor?: ScheduledTaskExecutionActor;
  lastRunAtMs?: number;
  nextRunAtMs?: number;
  originalRequest?: string;
  runNowAtMs?: number;
  schedule: ScheduledTaskSchedule;
  status: ScheduledTaskStatus;
  statusReason?: string;
  task: ScheduledTaskSpec;
  updatedAtMs: number;
}

export interface ScheduledRun {
  id: string;
  attempt: number;
  claimedAtMs: number;
  completedAtMs?: number;
  dispatchId?: string;
  errorMessage?: string;
  resultMessageTs?: string;
  scheduledForMs: number;
  startedAtMs?: number;
  status: ScheduledRunStatus;
  taskId: string;
}
