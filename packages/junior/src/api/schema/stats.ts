import { z } from "zod";

export const statSchema = z
  .object({
    count: z.number().int().nonnegative(),
    date: z.string(),
    metric: z.string().min(1),
    name: z.string().min(1),
    namespace: z.string().min(1),
  })
  .strict();

export const statsReportSchema = z
  .object({
    generatedAt: z.string().datetime(),
    stats: z.array(statSchema),
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

export type StatReport = z.infer<typeof statSchema>;
export type StatsReport = z.infer<typeof statsReportSchema>;
