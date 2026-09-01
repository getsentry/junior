import { z } from "zod";

const taskDestinationSchema = z
  .object({
    channelId: z.string().min(1),
    label: z.string().min(1),
    teamId: z.string().min(1),
    visibility: z.enum(["private", "public"]),
  })
  .strict();

/** Task run counts for the dashboard range control (24h/7d/30d/90d). */
export const taskRunWindowsSchema = z
  .object({
    1: z.number().int().nonnegative(),
    7: z.number().int().nonnegative(),
    30: z.number().int().nonnegative(),
    90: z.number().int().nonnegative(),
  })
  .strict();

const taskSummaryBaseSchema = z.object({
  createdAt: z.string().datetime(),
  createdBy: z.string().min(1),
  createdByEmail: z.string().trim().email().optional(),
  destination: taskDestinationSchema,
  id: z.string().min(1),
  instruction: z.string().min(1),
  lastConversationId: z.string().min(1).optional(),
  lastRunAt: z.string().datetime().optional(),
  ownedByViewer: z.boolean(),
  runs: taskRunWindowsSchema,
  /** Short display title; falls back from instruction when unset. */
  title: z.string().min(1),
  totalRuns: z.number().int().nonnegative(),
});

export const scheduledTaskSummarySchema = taskSummaryBaseSchema
  .extend({
    kind: z.literal("scheduled"),
    nextRunAt: z.string().datetime().optional(),
    schedule: z.string().min(1),
    status: z.enum(["active", "blocked", "completed"]),
  })
  .strict();

export const eventTaskSummarySchema = taskSummaryBaseSchema
  .extend({
    events: z.array(z.string().min(1)).min(1),
    kind: z.literal("event"),
    resource: z.string().min(1),
    source: z.string().min(1),
    triggerAvailable: z.boolean(),
  })
  .strict();

export const taskSummarySchema = z.discriminatedUnion("kind", [
  scheduledTaskSummarySchema,
  eventTaskSummarySchema,
]);

/** UTC day (`YYYY-MM-DD`) or hour (`YYYY-MM-DDTHH`) execution bucket key. */
export const taskMetricBucketSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2})?$/);

/** One UTC day/hour of completed task executions stacked by task type. */
export const taskExecutionDaySchema = z
  .object({
    /** Linked conversation spend for executions in this bucket. */
    costUsd: z.number().finite().nonnegative(),
    date: taskMetricBucketSchema,
    event: z.number().int().nonnegative(),
    scheduled: z.number().int().nonnegative(),
  })
  .strict();

export const taskListSchema = z
  .object({
    executionDays: z.array(taskExecutionDaySchema),
    executionHours: z.array(taskExecutionDaySchema).optional(),
    tasks: z.array(taskSummarySchema),
    truncated: z.boolean(),
  })
  .strict();

export const taskParamsSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["scheduled", "event"]),
  })
  .strict();

export const taskExecutionStatusSchema = z.enum([
  "blocked",
  "completed",
  "failed",
]);

export const taskExecutionSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    /** Estimated model cost for the linked conversation, when known. */
    costUsd: z.number().finite().nonnegative().optional(),
    /** Cumulative conversation runtime in milliseconds, when known. */
    durationMs: z.number().finite().nonnegative().optional(),
    executedAt: z.string().datetime(),
    executionId: z.string().min(1),
    status: taskExecutionStatusSchema,
    title: z.string().min(1).optional(),
    /** Cumulative conversation token total, when known. */
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

/** One UTC day/hour of terminal executions for a single task, stacked by status. */
export const taskExecutionStatusDaySchema = z
  .object({
    blocked: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    date: taskMetricBucketSchema,
    failed: z.number().int().nonnegative(),
  })
  .strict();

export const taskExecutionListSchema = z
  .object({
    executionDays: z.array(taskExecutionStatusDaySchema),
    executionHours: z.array(taskExecutionStatusDaySchema).optional(),
    executions: z.array(taskExecutionSchema),
    task: taskSummarySchema,
    truncated: z.boolean(),
  })
  .strict();

export const taskRunSchema = taskExecutionSchema
  .extend({
    kind: z.enum(["scheduled", "event"]),
    taskId: z.string().min(1),
    taskTitle: z.string().min(1),
  })
  .strict();

export const taskRunListSchema = z
  .object({
    runs: z.array(taskRunSchema),
    truncated: z.boolean(),
  })
  .strict();

export type TaskExecutionDay = z.output<typeof taskExecutionDaySchema>;
export type TaskExecutionStatusDay = z.output<
  typeof taskExecutionStatusDaySchema
>;
export type TaskExecution = z.output<typeof taskExecutionSchema>;
export type TaskExecutionList = z.output<typeof taskExecutionListSchema>;
export type TaskRun = z.output<typeof taskRunSchema>;
export type TaskRunList = z.output<typeof taskRunListSchema>;
export type TaskRunWindows = z.output<typeof taskRunWindowsSchema>;
export type TaskSummary = z.output<typeof taskSummarySchema>;
export type TaskList = z.output<typeof taskListSchema>;
