import * as z from "zod";
import { codeChangeStateSchema } from "@sentry/junior-plugin-api";

export const codeChangeSummarySchema = z
  .object({
    closed: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    created: z.number().int().nonnegative(),
    /** Open changes with no activity for more than {@link IDLE_CHANGE_DAYS} days. */
    idle: z.number().int().nonnegative(),
    medianCostUsd: z.number().nonnegative().optional(),
    medianMergeTimeMs: z.number().nonnegative().optional(),
    merged: z.number().int().nonnegative(),
    mergeRate: z.number().min(0).max(1).optional(),
    open: z.number().int().nonnegative(),
  })
  .strict();

/** Whole days without activity after which an open change counts as idle. */
export const IDLE_CHANGE_DAYS = 7;

/** UTC day (`YYYY-MM-DD`) or hour (`YYYY-MM-DDTHH`) activity bucket key. */
export const codeMetricBucketSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2})?$/);

export const codeActivityDaySchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    date: codeMetricBucketSchema,
    merged: z.number().int().nonnegative(),
  })
  .strict();

export const codeRepositorySummarySchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    id: z.string().uuid(),
    medianCostUsd: z.number().nonnegative().optional(),
    merged: z.number().int().nonnegative(),
    mergeRate: z.number().min(0).max(1).optional(),
    name: z.string().min(1),
    open: z.number().int().nonnegative(),
    provider: z.string().min(1),
    url: z.string().url().optional(),
  })
  .strict();

/**
 * Where a code change came from: the Automation that ran its first
 * Conversation, or else that Conversation's root. Code · Mine stacks the
 * changes of one source.
 */
export const codeChangeStackSchema = z
  .object({
    /** The Automation id, or the root Conversation id. */
    id: z.string().min(1),
    kind: z.enum(["automation", "conversation"]),
    title: z.string().optional(),
  })
  .strict();

export const codeChangeSummaryReportSchema = z
  .object({
    closedAt: z.string().optional(),
    id: z.string().uuid(),
    /**
     * Latest push, review, or comment by a person. Absent when the code
     * plugin has seen no activity; readers fall back to `openedAt`.
     */
    lastActivityAt: z.string().optional(),
    mergedAt: z.string().optional(),
    number: z.number().int().positive(),
    openedAt: z.string(),
    provider: z.string().min(1),
    repository: z.string().min(1),
    /** Set only on a person's changes, when the viewer may read the source. */
    stack: codeChangeStackSchema.optional(),
    state: codeChangeStateSchema,
    title: z.string().optional(),
    url: z.string().url().optional(),
  })
  .strict();

export const codeOverviewReportSchema = z
  .object({
    activityDays: z.array(codeActivityDaySchema),
    activityHours: z.array(codeActivityDaySchema).optional(),
    activitySixHours: z.array(codeActivityDaySchema).optional(),
    changes: z.array(codeChangeSummaryReportSchema),
    generatedAt: z.string(),
    repositories: z.array(codeRepositorySummarySchema),
    summary: codeChangeSummarySchema,
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

/** A search of tracked code changes, for the composer `#` menu. */
export const codeChangeSearchQuerySchema = z
  .object({ q: z.string().trim().min(1).max(100) })
  .strict();

/** A tracked code change that a Message can link to. */
export const mentionableCodeChangeSchema = z
  .object({
    number: z.number().int(),
    /** `owner/repo`. */
    repository: z.string(),
    state: codeChangeStateSchema,
    title: z.string().nullable(),
    url: z.string(),
  })
  .strict();

export const codeChangeSearchReportSchema = z
  .object({ changes: z.array(mentionableCodeChangeSchema) })
  .strict();

export const codeRepositoryParamsSchema = z
  .object({ repositoryId: z.string().uuid() })
  .strict();

/** Optional change state that limits the listed repository changes. */
export const codeRepositoryQuerySchema = z
  .object({ state: codeChangeStateSchema.optional() })
  .strict();

/** Code activity, recent changes, and Workspaces for one repository. */
export const codeRepositoryReportSchema = z
  .object({
    activityDays: z.array(codeActivityDaySchema),
    activityHours: z.array(codeActivityDaySchema).optional(),
    activitySixHours: z.array(codeActivityDaySchema).optional(),
    /** Every code change in the repository by state, past the listed ones. */
    changeCounts: z
      .object({
        closed: z.number().int().nonnegative(),
        merged: z.number().int().nonnegative(),
        open: z.number().int().nonnegative(),
      })
      .strict(),
    changes: z.array(codeChangeSummaryReportSchema),
    generatedAt: z.string(),
    repository: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1),
        provider: z.string().min(1),
        url: z.string().url().optional(),
      })
      .strict(),
    summary: codeChangeSummarySchema,
    windowEnd: z.string(),
    windowStart: z.string(),
    workspaces: z.array(
      z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
    ),
  })
  .strict();

/** Person-scoped code activity and recent code changes for one People profile. */
export const codePersonReportSchema = z
  .object({
    activityDays: z.array(codeActivityDaySchema),
    activityHours: z.array(codeActivityDaySchema).optional(),
    activitySixHours: z.array(codeActivityDaySchema).optional(),
    changes: z.array(codeChangeSummaryReportSchema),
    generatedAt: z.string(),
    /** Set when `changes` is a full page: pass it as `cursor` for the next. */
    nextCursor: z.string().optional(),
    summary: codeChangeSummarySchema,
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

/** Query for one page of a person's code changes. */
export const personCodeQuerySchema = z
  .object({
    /** `nextCursor` from the previous page. */
    cursor: z.string().min(1).max(500).optional(),
  })
  .strict();

export type CodeActivityDay = z.infer<typeof codeActivityDaySchema>;
export type CodeChangeSearchReport = z.infer<
  typeof codeChangeSearchReportSchema
>;
export type CodeChangeStack = z.infer<typeof codeChangeStackSchema>;
export type CodeChangeSummaryReport = z.infer<
  typeof codeChangeSummaryReportSchema
>;
export type CodeOverviewReport = z.infer<typeof codeOverviewReportSchema>;
export type CodePersonReport = z.infer<typeof codePersonReportSchema>;
export type CodeRepositoryReport = z.infer<typeof codeRepositoryReportSchema>;
export type CodeRepositorySummary = z.infer<typeof codeRepositorySummarySchema>;
export type MentionableCodeChange = z.infer<typeof mentionableCodeChangeSchema>;
