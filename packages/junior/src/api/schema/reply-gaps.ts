import * as z from "zod";

/** Reply gaps in the bins of the cache warming model. */
export const replyGapHistogramSchema = z
  .object({
    bins: z.array(
      z
        .object({
          count: z.number().int().nonnegative(),
          endMs: z.number().int().positive(),
          startMs: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    /** Idle periods with no reply before the cache warming horizon. */
    noReply: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

/** Gap histogram of each cache warming segment, over all Conversations. */
export const replyGapSegmentsReportSchema = z
  .object({
    generatedAt: z.string().datetime(),
    /** Below this many gaps, the planner does not warm the segment. */
    minSamples: z.number().int().positive(),
    segments: z.array(
      z
        .object({
          histogram: replyGapHistogramSchema,
          segment: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

/** Time range of the reply gaps on a People profile. */
export const personReplyGapsQuerySchema = z
  .object({
    days: z.enum(["1", "7", "30", "90"]).default("30").transform(Number),
  })
  .strict();

/** Reply gaps that end with an instruction of the profile's person. */
export const personReplyGapsReportSchema = z
  .object({
    days: z.number().int().positive(),
    generatedAt: z.string().datetime(),
    histogram: replyGapHistogramSchema,
  })
  .strict();

export type ReplyGapHistogram = z.infer<typeof replyGapHistogramSchema>;
export type ReplyGapSegmentsReport = z.infer<
  typeof replyGapSegmentsReportSchema
>;
export type PersonReplyGapsReport = z.infer<typeof personReplyGapsReportSchema>;
