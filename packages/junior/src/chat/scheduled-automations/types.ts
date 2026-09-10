/** Durable scheduled-automation domain types owned by Junior core. */
import {
  actorUserIdSchema,
  slackDestinationSchema,
  taskOutcomeSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const scheduledAutomationStatusSchema = z.enum([
  "active",
  "blocked",
  "completed",
  "deleted",
]);
export type ScheduledAutomationStatus = z.output<
  typeof scheduledAutomationStatusSchema
>;
const scheduledAutomationCredentialModeSchema = z.enum(["system", "creator"]);
export type ScheduledAutomationCredentialMode = z.output<
  typeof scheduledAutomationCredentialModeSchema
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

const scheduledAutomationPrincipalSchema = z
  .object({
    slackUserId: actorUserIdSchema,
    fullName: z.string().optional(),
    userName: z.string().optional(),
  })
  .strict();

const scheduledAutomationRecurrenceSchema = z
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

const scheduledAutomationScheduleSchema = z
  .object({
    description: z.string(),
    kind: z.enum(["one_off", "recurring"]),
    recurrence: scheduledAutomationRecurrenceSchema.optional(),
    timezone: z.string(),
  })
  .strict();

const scheduledAutomationExecutionActorSchema = z
  .object({
    platform: z.literal("system"),
    name: z.string(),
  })
  .strict();

/** Validate the current scheduled-automation domain shape. */
export const scheduledAutomationSchema = z
  .object({
    id: z.string(),
    conversationAccess: z
      .object({
        audience: z.enum(["direct", "group", "channel"]),
        visibility: z.enum(["private", "public"]),
      })
      .strict(),
    createdAtMs: z.number(),
    createdBy: scheduledAutomationPrincipalSchema,
    /** Authoritative provider identity that created the task. */
    creatorIdentityId: z.string(),
    /** Selects system credentials or task-bound creator credential delegation. */
    credentialMode: scheduledAutomationCredentialModeSchema,
    destination: slackDestinationSchema,
    executionActor: scheduledAutomationExecutionActorSchema.optional(),
    lastRunAtMs: z.number().optional(),
    nextRunAtMs: z.number().optional(),
    originalRequest: z.string().optional(),
    runNowAtMs: z.number().optional(),
    schedule: scheduledAutomationScheduleSchema,
    status: scheduledAutomationStatusSchema,
    statusReason: z.string().optional(),
    /** Explicit visible effects after successful work. An empty list is silent. */
    outcomes: z.array(taskOutcomeSchema).max(5),
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

export type ScheduledAutomation = z.output<typeof scheduledAutomationSchema>;
export type ScheduledRun = z.output<typeof scheduledRunSchema>;
export type ScheduledAutomationRecord = Omit<ScheduledAutomation, "title">;
export type ScheduledAutomationPrincipal = ScheduledAutomation["createdBy"];
export type ScheduledAutomationExecutionActor = NonNullable<
  ScheduledAutomation["executionActor"]
>;
export type ScheduledAutomationConversationAccess =
  ScheduledAutomation["conversationAccess"];
export type ScheduledAutomationSchedule = ScheduledAutomation["schedule"];
export type ScheduledAutomationRecurrence = NonNullable<
  ScheduledAutomationSchedule["recurrence"]
>;
export type ScheduledAutomationSpec = ScheduledAutomation["task"];
export type ScheduledCalendarFrequency =
  ScheduledAutomationRecurrence["frequency"];
export type ScheduledLocalTime = ScheduledAutomationRecurrence["time"];

export const SCHEDULED_AUTOMATION_SYSTEM_ACTOR = Object.freeze({
  platform: "system",
  name: "scheduled-automation",
} satisfies ScheduledAutomationExecutionActor);
