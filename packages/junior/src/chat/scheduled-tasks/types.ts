/** Durable scheduled-task domain types owned by Junior core. */
import type { SlackDestination, SystemActor } from "@sentry/junior-plugin-api";
import { z } from "zod";

export type ScheduledTaskStatus =
  | "active"
  | "blocked"
  | "completed"
  | "deleted";
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
  visibility: "private" | "public";
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
  /** Authoritative provider identity that created the task. */
  creatorIdentityId: string;
  conversationAccess: ScheduledTaskConversationAccess;
  /** Selects system credentials or task-bound creator credential delegation. */
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
  /**
   * Short display title generated from the task instruction.
   * SQL-backed column; never stored inside the JSON record payload.
   */
  title?: string;
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
