import { z } from "zod";

/**
 * Native Slack render intents.
 *
 * Intents are the closed, core-owned vocabulary the model picks from when
 * it wants richer presentation than a plain mrkdwn reply. Plugins teach
 * intent usage through their SKILL.md; they do not extend the palette.
 *
 * Adding a new intent kind is a core change. Renderers for each intent
 * live alongside this file in `renderer.ts`.
 */

const actionSchema = z.object({
  label: z.string().min(1).max(64),
  url: z.string().url(),
});

const fieldSchema = z.object({
  label: z.string().min(1).max(64),
  value: z.string().min(1).max(1024),
});

const plainReplySchema = z.object({
  kind: z.literal("plain_reply"),
  text: z.string().min(1),
});

const summaryCardSchema = z.object({
  actions: z.array(actionSchema).max(5).optional(),
  body: z.string().max(2000).optional(),
  fields: z.array(fieldSchema).max(10).optional(),
  kind: z.literal("summary_card"),
  subtitle: z.string().max(200).optional(),
  title: z.string().min(1).max(200),
});

const alertSchema = z.object({
  actions: z.array(actionSchema).max(3).optional(),
  body: z.string().max(1000).optional(),
  kind: z.literal("alert"),
  severity: z.enum(["info", "success", "warning", "error"]),
  title: z.string().min(1).max(200),
});

const comparisonTableSchema = z.object({
  columns: z.array(z.string().min(1).max(64)).min(2).max(6),
  kind: z.literal("comparison_table"),
  rows: z
    .array(z.array(z.string().max(200)).min(2).max(6))
    .min(1)
    .max(20),
  title: z.string().max(200).optional(),
});

const resultCarouselItemSchema = z.object({
  body: z.string().max(500).optional(),
  fields: z.array(fieldSchema).max(5).optional(),
  subtitle: z.string().max(200).optional(),
  title: z.string().min(1).max(200),
  url: z.string().url().optional(),
});

const resultCarouselSchema = z.object({
  items: z.array(resultCarouselItemSchema).min(1).max(10),
  kind: z.literal("result_carousel"),
  title: z.string().max(200).optional(),
});

const progressPlanTaskSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(["pending", "in_progress", "complete", "error"]),
  title: z.string().min(1).max(200),
});

const progressPlanSchema = z.object({
  kind: z.literal("progress_plan"),
  tasks: z.array(progressPlanTaskSchema).min(1).max(20),
  title: z.string().min(1).max(200),
});

export const slackRenderIntentSchema = z.discriminatedUnion("kind", [
  plainReplySchema,
  summaryCardSchema,
  alertSchema,
  comparisonTableSchema,
  resultCarouselSchema,
  progressPlanSchema,
]);

export type SlackRenderIntent = z.infer<typeof slackRenderIntentSchema>;
export type SlackRenderIntentKind = SlackRenderIntent["kind"];

export type PlainReplyIntent = z.infer<typeof plainReplySchema>;
export type SummaryCardIntent = z.infer<typeof summaryCardSchema>;
export type AlertIntent = z.infer<typeof alertSchema>;
export type ComparisonTableIntent = z.infer<typeof comparisonTableSchema>;
export type ResultCarouselIntent = z.infer<typeof resultCarouselSchema>;
export type ProgressPlanIntent = z.infer<typeof progressPlanSchema>;

export type SlackRenderIntentAction = z.infer<typeof actionSchema>;
export type SlackRenderIntentField = z.infer<typeof fieldSchema>;
