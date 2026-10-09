import { scheduleIntentSchema } from "@/chat/scheduled-automations/schedule-intent";
import { pluginEventTypeSchema } from "@sentry/junior-plugin-api";
import { scheduledAutomationSchema } from "@/chat/scheduled-automations/types";
import {
  eventAutomationPrincipalSchema,
  eventAutomationSchema,
  eventAutomationTriggerSchema,
} from "@/chat/event-automations/types";
import {
  scheduledAutomationEditSchema,
  eventAutomationEditSchema,
} from "@/chat/automations/edit-schema";
import { eventMatchSchema, taskOutcomeSchema } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { automationVisibilitySchema } from "@/chat/automations/visibility";

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
  credentialMode: z.enum(["creator", "system"]),
  createdAt: z.string().datetime(),
  createdBy: z.string().min(1),
  createdByAvatarUrl: z.string().url().optional(),
  createdByEmail: z.string().trim().email().optional(),
  destination: automationDestinationSchema,
  id: z.string().min(1),
  instruction: z.string().min(1),
  lastConversationId: z.string().min(1).optional(),
  lastRunAt: z.string().datetime().optional(),
  lastRunStatus: z.enum(["blocked", "completed", "failed"]).optional(),
  ownedByViewer: z.boolean(),
  runs: automationRunWindowsSchema,
  outcomes: z.array(taskOutcomeSchema).max(5),
  /** Short display title; falls back from instruction when unset. */
  title: z.string().min(1),
  totalRuns: z.number().int().nonnegative(),
  /** Who can see the Automation: the creator override, else the Destination. */
  visibility: automationVisibilitySchema,
  /** Creator override. Null follows the Destination. */
  visibilityOverride: automationVisibilitySchema.nullable(),
});

export const scheduledAutomationSummarySchema = automationSummaryBaseSchema
  .extend({
    kind: z.literal("scheduled"),
    nextRunAt: z.string().datetime().optional(),
    schedule: z.string().min(1),
    timezone: z.string().min(1),
    statusReason: z.string().optional(),
    status: z.enum(["active", "blocked", "paused", "completed"]),
  })
  .strict();

export const eventAutomationSummarySchema = automationSummaryBaseSchema
  .extend({
    events: z.array(z.string().min(1)).min(1),
    match: eventMatchSchema.optional(),
    kind: z.literal("event"),
    resource: z.string().min(1),
    source: z.string().min(1),
    triggerAvailable: z.boolean(),
    status: z.enum(["active", "paused"]),
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
    scope: z.enum(["all", "mine", "public", "attention"]).default("all"),
    type: z.enum(["all", "scheduled", "event"]).default("all"),
    state: z
      .enum(["all", "active", "blocked", "paused", "completed", "unavailable"])
      .default("all"),
    creator: z.string().max(300).optional(),
    destination: z.string().max(300).optional(),
    sort: z.enum(["newest", "oldest", "title"]).default("newest"),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const automationFilterOptionSchema = z
  .object({
    value: z.string(),
    label: z.string(),
  })
  .strict();

export const automationListSchema = z
  .object({
    executionDays: z.array(automationExecutionDaySchema),
    executionHours: z.array(automationExecutionDaySchema).optional(),
    executionSixHours: z.array(automationExecutionDaySchema).optional(),
    automations: z.array(automationSummarySchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    counts: z
      .object({
        all: z.number().int().nonnegative(),
        mine: z.number().int().nonnegative(),
        public: z.number().int().nonnegative(),
        private: z.number().int().nonnegative(),
      })
      .strict(),
    creators: z.array(automationFilterOptionSchema),
    destinations: z.array(automationFilterOptionSchema),
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

const automationDefinitionFields = {
  title: z.string().nullable(),
  instruction: z.string(),
};

const automationVersionFields = {
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  /** Null for versions saved by the upgrade, because the editor is unknown. */
  editedBy: eventAutomationPrincipalSchema.nullable(),
};

/** One saved Automation definition. Newer versions have larger numbers. */
export const automationVersionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...automationVersionFields,
      kind: z.literal("scheduled"),
      definition: scheduledAutomationSchema
        .pick({
          credentialMode: true,
          destination: true,
          outcomes: true,
          schedule: true,
        })
        .extend(automationDefinitionFields)
        .strict(),
    })
    .strict(),
  z
    .object({
      ...automationVersionFields,
      kind: z.literal("event"),
      definition: eventAutomationSchema
        .pick({
          credentialMode: true,
          destination: true,
          outcomes: true,
          trigger: true,
        })
        .extend(automationDefinitionFields)
        .strict(),
    })
    .strict(),
]);

/** Newest versions first. */
export const automationVersionListSchema = z
  .object({
    versions: z.array(automationVersionSchema),
    /** Newest version that matches the current definition. Null when none match. */
    activeVersion: z.number().int().positive().nullable(),
    truncated: z.boolean(),
  })
  .strict();

export const automationVersionParamsSchema = automationParamsSchema
  .extend({ version: z.coerce.number().int().positive() })
  .strict();

export type AutomationVersion = z.output<typeof automationVersionSchema>;
export type AutomationVersionList = z.output<
  typeof automationVersionListSchema
>;

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

export type AutomationListQuery = z.output<typeof automationListQuerySchema>;

const automationRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Make a saved version active. The revision is the edit read revision. */
export const automationVersionActivateSchema = z
  .object({ revision: automationRevisionSchema })
  .strict();

/** Pause and resume do not start work. */
export const automationLifecycleSchema = z
  .object({
    action: z.enum(["pause", "resume"]),
    revision: automationRevisionSchema,
  })
  .strict();

const automationEditBaseSchema = scheduledAutomationSchema
  .pick({ destination: true, createdBy: true })
  .extend({
    id: z.string().min(1),
    revision: automationRevisionSchema,
    title: z.string().nullable(),
    instruction: z.string(),
    credentialMode: z.enum(["system", "creator"]),
    outcomes: z.array(taskOutcomeSchema).max(5),
    /** Creator-only rules apply when false. */
    ownedByViewer: z.boolean(),
    /** Creator override. Null follows the Destination. */
    visibility: automationVisibilitySchema.nullable(),
  });

/** Edit values for owners and public readers. Read schemas also retain legacy values. */
export const automationEditSchema = z.discriminatedUnion("kind", [
  automationEditBaseSchema
    .merge(scheduledAutomationSchema.pick({ schedule: true }))
    .extend({
      kind: z.literal("scheduled"),
      nextRunAtMs: z.number().optional(),
      status: z.enum(["active", "blocked", "paused", "completed"]),
    })
    .strict(),
  automationEditBaseSchema
    .extend({
      kind: z.literal("event"),
      trigger: eventAutomationTriggerSchema,
      triggerAvailable: z.boolean(),
      status: z.enum(["active", "paused"]),
    })
    .strict(),
]);

/** Creator-only. Null clears the override so the Destination decides. */
const automationVisibilityUpdateSchema = automationVisibilitySchema
  .nullable()
  .optional();

/** Partial edits require the revision returned by the edit read. */
export const automationUpdateSchema = z.discriminatedUnion("kind", [
  scheduledAutomationEditSchema
    .omit({ status: true })
    .extend({
      kind: z.literal("scheduled"),
      revision: automationRevisionSchema,
      visibility: automationVisibilityUpdateSchema,
    })
    .strict(),
  eventAutomationEditSchema
    .extend({
      kind: z.literal("event"),
      revision: automationRevisionSchema,
      visibility: automationVisibilityUpdateSchema,
    })
    .strict(),
]);

export const automationEditErrorSchema = z
  .object({
    error: z.string(),
    code: z.enum(["invalid_edit", "conflict", "not_found"]),
    fields: z.record(z.string(), z.array(z.string())).optional(),
  })
  .strict();

export type AutomationEdit = z.output<typeof automationEditSchema>;
export type AutomationUpdate = z.output<typeof automationUpdateSchema>;

/** Catalog metadata only; callbacks and provider connections stay on the server. */
export const automationEventCatalogSchema = z.array(
  pluginEventTypeSchema.safeExtend({ namespace: z.string() }),
);
export const automationScheduleIntentSchema = scheduleIntentSchema;
export const automationSchedulePreviewSchema = scheduledAutomationSchema
  .pick({ schedule: true })
  .extend({ nextRunAtMs: z.number() })
  .strict();
export type AutomationScheduleIntent = z.output<
  typeof automationScheduleIntentSchema
>;
