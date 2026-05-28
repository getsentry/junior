export type ScheduledTaskStatus = "active" | "paused" | "blocked" | "deleted";

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

export interface ScheduledTaskExecutionActor {
  type: "system";
  id: string;
}

export const SCHEDULED_TASK_SYSTEM_ACTOR = Object.freeze({
  type: "system",
  id: "scheduled-task",
} satisfies ScheduledTaskExecutionActor);

export interface ScheduledTaskDestination {
  platform: "slack";
  teamId: string;
  channelId: string;
}

export interface ScheduledTaskConversationAccess {
  audience: "direct" | "group" | "channel";
  visibility: "private" | "public" | "unknown";
}

export interface ScheduledTaskCredentialSubject {
  type: "user";
  userId: string;
  allowedWhen: "private-direct-conversation";
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
  credentialSubject?: ScheduledTaskCredentialSubject;
  destination: ScheduledTaskDestination;
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
  version: number;
}

export interface ScheduledRun {
  id: string;
  attempt: number;
  claimedAtMs: number;
  completedAtMs?: number;
  dispatchId?: string;
  errorMessage?: string;
  idempotencyKey: string;
  resultMessageTs?: string;
  scheduledForMs: number;
  startedAtMs?: number;
  status: ScheduledRunStatus;
  taskId: string;
  taskVersion: number;
}
