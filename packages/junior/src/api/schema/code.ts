import { z } from "zod";
import { codeChangeStateSchema } from "@sentry/junior-plugin-api";

export const codeChangeSummarySchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    medianMergeTimeMs: z.number().nonnegative().optional(),
    merged: z.number().int().nonnegative(),
    mergeRate: z.number().min(0).max(1).optional(),
    open: z.number().int().nonnegative(),
  })
  .strict();

export const codeActivityDaySchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    date: z.string().date(),
    merged: z.number().int().nonnegative(),
  })
  .strict();

export const codeRepositorySummarySchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    id: z.string().uuid(),
    merged: z.number().int().nonnegative(),
    mergeRate: z.number().min(0).max(1).optional(),
    name: z.string().min(1),
    open: z.number().int().nonnegative(),
    provider: z.string().min(1),
    url: z.string().url().optional(),
  })
  .strict();

export const codeChangeSummaryReportSchema = z
  .object({
    closedAt: z.string().optional(),
    id: z.string().uuid(),
    mergedAt: z.string().optional(),
    number: z.number().int().positive(),
    openedAt: z.string(),
    provider: z.string().min(1),
    repository: z.string().min(1),
    state: codeChangeStateSchema,
    title: z.string().optional(),
    url: z.string().url().optional(),
  })
  .strict();

export const codeOverviewReportSchema = z
  .object({
    activityDays: z.array(codeActivityDaySchema),
    changes: z.array(codeChangeSummaryReportSchema),
    generatedAt: z.string(),
    repositories: z.array(codeRepositorySummarySchema),
    summary: codeChangeSummarySchema,
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

export type CodeActivityDay = z.infer<typeof codeActivityDaySchema>;
export type CodeChangeSummaryReport = z.infer<
  typeof codeChangeSummaryReportSchema
>;
export type CodeOverviewReport = z.infer<typeof codeOverviewReportSchema>;
export type CodeRepositorySummary = z.infer<typeof codeRepositorySummarySchema>;
