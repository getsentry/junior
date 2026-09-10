import { taskOutcomeSchema } from "@sentry/junior-plugin-api";
import { z } from "zod";

const automationDestinationSchema = z
  .object({
    channelId: z.string().min(1),
    label: z.string().min(1),
    teamId: z.string().min(1),
    visibility: z.enum(["private", "public"]),
  })
  .strict();

/** Automation run counts for the dashboard range control (24h/7d/30d/90d). */
export const automationRunWindowsSchema = z
  .object({
    1: z.number().int().nonnegative(),
    7: z.number().int().nonnegative(),
    30: z.number().int().nonnegative(),
    90: z.number().int().nonnegative(),
  })
  .strict();

const automationSummaryBaseSchema = z.object({
  createdAt: z.string().datetime(),
  createdBy: z.string().min(1),
  createdByEmail: z.string().trim().email().optional(),
  destination: automationDestinationSchema,
  id: z.string().min(1),
  instruction: z.string().min(1),
  lastConversationId: z.string().min(1).optional(),
  lastRunAt: z.string().datetime().optional(),
  ownedByViewer: z.boolean(),
  runs: automationRunWindowsSchema,
  outcomes: z.array(taskOutcomeSchema).max(5),
  /** Short display title; falls back from instruction when unset. */
  title: z.string().min(1),
  totalRuns: z.number().int().nonnegative(),
});

export const scheduledAutomationSummarySchema = automationSummaryBaseSchema
  .extend({
    kind: z.literal("scheduled"),
    nextRunAt: z.string().datetime().optional(),
    schedule: z.string().min(1),
    status: z.enum(["active", "blocked", "completed"]),
  })
  .strict();

export const eventAutomationSummarySchema = automationSummaryBaseSchema
  .extend({
    events: z.array(z.string().min(1)).min(1),
    kind: z.literal("event"),
    resource: z.string().min(1),
    source: z.string().min(1),
    triggerAvailable: z.boolean(),
  })
  .strict();

export const automationSummarySchema = z.discriminatedUnion("kind", [
  scheduledAutomationSummarySchema,
  eventAutomationSummarySchema,
]);

/** UTC day (`YYYY-MM-DD`) or hour (`YYYY-MM-DDTHH`) execution bucket key. */
export const automationMetricBucketSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2})?$/);

/** One UTC day/hour of completed automation executions stacked by automation type. */
export const automationExecutionDaySchema = z
  .object({
    /** Linked conversation spend for executions in this bucket. */
    costUsd: z.number().finite().nonnegative(),
    date: automationMetricBucketSchema,
    event: z.number().int().nonnegative(),
    scheduled: z.number().int().nonnegative(),
  })
  .strict();

export const automationListQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
  })
  .strict();

export const automationListSchema = z
  .object({
    executionDays: z.array(automationExecutionDaySchema),
    executionHours: z.array(automationExecutionDaySchema).optional(),
    executionSixHours: z.array(automationExecutionDaySchema).optional(),
    automations: z.array(automationSummarySchema),
    truncated: z.boolean(),
  })
  .strict();

export const automationParamsSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["scheduled", "event"]),
  })
  .strict();

export const automationExecutionStatusSchema = z.enum([
  "blocked",
  "completed",
  "failed",
]);

export const automationExecutionSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    /** Estimated model cost for the linked conversation, when known. */
    costUsd: z.number().finite().nonnegative().optional(),
    /** Cumulative conversation runtime in milliseconds, when known. */
    durationMs: z.number().finite().nonnegative().optional(),
    executedAt: z.string().datetime(),
    executionId: z.string().min(1),
    status: automationExecutionStatusSchema,
    title: z.string().min(1).optional(),
    /** Cumulative conversation token total, when known. */
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

/** One UTC day/hour of terminal executions for a single automation, stacked by status. */
export const automationExecutionStatusDaySchema = z
  .object({
    blocked: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    date: automationMetricBucketSchema,
    failed: z.number().int().nonnegative(),
  })
  .strict();

export const automationExecutionListSchema = z
  .object({
    executionDays: z.array(automationExecutionStatusDaySchema),
    executionHours: z.array(automationExecutionStatusDaySchema).optional(),
    executionSixHours: z.array(automationExecutionStatusDaySchema).optional(),
    executions: z.array(automationExecutionSchema),
    automation: automationSummarySchema,
    truncated: z.boolean(),
  })
  .strict();

export const automationRunSchema = automationExecutionSchema
  .extend({
    kind: z.enum(["scheduled", "event"]),
    automationId: z.string().min(1),
    automationTitle: z.string().min(1),
  })
  .strict();

export const automationRunListSchema = z
  .object({
    runs: z.array(automationRunSchema),
    truncated: z.boolean(),
  })
  .strict();

export type AutomationExecutionDay = z.output<
  typeof automationExecutionDaySchema
>;
export type AutomationExecutionStatusDay = z.output<
  typeof automationExecutionStatusDaySchema
>;
export type AutomationExecution = z.output<typeof automationExecutionSchema>;
export type AutomationExecutionList = z.output<
  typeof automationExecutionListSchema
>;
export type AutomationRun = z.output<typeof automationRunSchema>;
export type AutomationRunList = z.output<typeof automationRunListSchema>;
export type AutomationRunWindows = z.output<typeof automationRunWindowsSchema>;
export type AutomationSummary = z.output<typeof automationSummarySchema>;
export type AutomationList = z.output<typeof automationListSchema>;
