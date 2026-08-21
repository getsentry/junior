/** Durable scheduled-task domain types owned by Junior core. */
import {
  slackActorSchema,
  slackDestinationSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const scheduledTaskStatusSchema = z.enum([
  "active",
  "blocked",
  "completed",
  "deleted",
]);
export type ScheduledTaskStatus = z.output<typeof scheduledTaskStatusSchema>;
const scheduledTaskCredentialModeSchema = z.enum(["system", "creator"]);
export type ScheduledTaskCredentialMode = z.output<
  typeof scheduledTaskCredentialModeSchema
>;

const scheduledRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
  "skipped",
]);
export type ScheduledRunStatus = z.output<typeof scheduledRunStatusSchema>;

const scheduledTaskPrincipalSchema = z
  .object({
    slackUserId: slackActorSchema.shape.userId,
    fullName: z.string().optional(),
    userName: z.string().optional(),
  })
  .strict();

const scheduledTaskRecurrenceSchema = z
  .object({
    dayOfMonth: z.number().optional(),
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number(),
    month: z.number().optional(),
    startDate: z.string(),
    time: z
      .object({
        hour: z.number(),
        minute: z.number(),
      })
      .strict(),
    weekdays: z.array(z.number()).optional(),
  })
  .strict();

const scheduledTaskScheduleSchema = z
  .object({
    description: z.string(),
    kind: z.enum(["one_off", "recurring"]),
    recurrence: scheduledTaskRecurrenceSchema.optional(),
    timezone: z.string(),
  })
  .strict();

const scheduledTaskExecutionActorSchema = z
  .object({
    platform: z.literal("system"),
    name: z.string(),
  })
  .strict();

/** Validate the current scheduled-task domain shape. */
export const scheduledTaskSchema = z
  .object({
    id: z.string(),
    conversationAccess: z
      .object({
        audience: z.enum(["direct", "group", "channel"]),
        visibility: z.enum(["private", "public"]),
      })
      .strict(),
    createdAtMs: z.number(),
    createdBy: scheduledTaskPrincipalSchema,
    /** Authoritative provider identity that created the task. */
    creatorIdentityId: z.string(),
    /** Selects system credentials or task-bound creator credential delegation. */
    credentialMode: scheduledTaskCredentialModeSchema,
    destination: slackDestinationSchema,
    executionActor: scheduledTaskExecutionActorSchema.optional(),
    lastRunAtMs: z.number().optional(),
    nextRunAtMs: z.number().optional(),
    originalRequest: z.string().optional(),
    runNowAtMs: z.number().optional(),
    schedule: scheduledTaskScheduleSchema,
    status: scheduledTaskStatusSchema,
    statusReason: z.string().optional(),
    task: z.object({ text: z.string() }).strict(),
    /** SQL-backed short display title generated from the task instruction. */
    title: z.string().optional(),
    updatedAtMs: z.number(),
  })
  .strict();

/** Validate the current scheduled-run domain shape. */
export const scheduledRunSchema = z
  .object({
    id: z.string(),
    attempt: z.number(),
    claimedAtMs: z.number(),
    completedAtMs: z.number().optional(),
    dispatchId: z.string().optional(),
    errorMessage: z.string().optional(),
    resultMessageTs: z.string().optional(),
    scheduledForMs: z.number(),
    startedAtMs: z.number().optional(),
    status: scheduledRunStatusSchema,
    taskId: z.string(),
  })
  .strict();

export type ScheduledTask = z.output<typeof scheduledTaskSchema>;
export type ScheduledRun = z.output<typeof scheduledRunSchema>;
export type ScheduledTaskRecord = Omit<ScheduledTask, "title">;
export type ScheduledTaskPrincipal = ScheduledTask["createdBy"];
export type ScheduledTaskExecutionActor = NonNullable<
  ScheduledTask["executionActor"]
>;
export type ScheduledTaskConversationAccess =
  ScheduledTask["conversationAccess"];
export type ScheduledTaskSchedule = ScheduledTask["schedule"];
export type ScheduledTaskRecurrence = NonNullable<
  ScheduledTaskSchedule["recurrence"]
>;
export type ScheduledTaskSpec = ScheduledTask["task"];
export type ScheduledCalendarFrequency = ScheduledTaskRecurrence["frequency"];
export type ScheduledLocalTime = ScheduledTaskRecurrence["time"];

export const SCHEDULED_TASK_SYSTEM_ACTOR = Object.freeze({
  platform: "system",
  name: "scheduled-task",
} satisfies ScheduledTaskExecutionActor);
