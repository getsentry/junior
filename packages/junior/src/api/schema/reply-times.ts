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

/** Time range of the reply times on a People profile. */
export const personReplyTimesQuerySchema = z
  .object({
    days: z.enum(["1", "7", "30", "90"]).default("30").transform(Number),
  })
  .strict();

/** Reply times that end with an instruction of the profile's person. */
export const personReplyTimesReportSchema = z
  .object({
    days: z.number().int().positive(),
    /** Reply times by the Turn depth of the idle period. */
    depths: z.array(
      z
        .object({
          depth: z.enum(["1", "2-3", "4+"]),
          histogram: replyTimeHistogramSchema,
        })
        .strict(),
    ),
    generatedAt: z.string().datetime(),
    histogram: replyTimeHistogramSchema,
    /** Some Conversations had too much history to read in time. */
    partial: z.boolean(),
  })
  .strict();

export type ReplyTimeHistogram = z.infer<typeof replyTimeHistogramSchema>;
export type ReplyTimeSegmentsReport = z.infer<
  typeof replyTimeSegmentsReportSchema
>;
export type PersonReplyTimesReport = z.infer<
  typeof personReplyTimesReportSchema
>;
