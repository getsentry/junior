import * as z from "zod";

/** Reply times in the bins of the cache warming model. */
export const replyTimeHistogramSchema = z
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
export const replyTimeSegmentsReportSchema = z
  .object({
    generatedAt: z.string().datetime(),
    /**
     * Below this many gaps, the planner leans on the segment's `none`
     * segment, or does not warm a `none` segment.
     */
    minSamples: z.number().int().positive(),
    segments: z.array(
      z
        .object({
          histogram: replyTimeHistogramSchema,
          segment: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type ReplyTimeHistogram = z.infer<typeof replyTimeHistogramSchema>;
export type ReplyTimeSegmentsReport = z.infer<
  typeof replyTimeSegmentsReportSchema
>;
