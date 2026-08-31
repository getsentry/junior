import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { fetchDashboardJson } from "../../http";

const memoryBucketSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2})?$/);

const memoryDaySchema = z
  .object({
    date: memoryBucketSchema,
    personal: z.number().int().min(0),
    public: z.number().int().min(0),
  })
  .strict();

const memoryCostDaySchema = z
  .object({
    costUsd: z.number().finite().min(0),
    date: memoryBucketSchema,
    events: z.number().int().min(0),
  })
  .strict();

export const memoryDashboardSchema = z
  .object({
    days: z.array(memoryDaySchema).length(90),
    extractionDays: z.array(memoryCostDaySchema).length(90),
    extractionHours: z.array(memoryCostDaySchema).length(24).optional(),
    generatedAt: z.iso.datetime(),
    hours: z.array(memoryDaySchema).length(24).optional(),
    recallDays: z.array(memoryCostDaySchema).length(90),
    recallHours: z.array(memoryCostDaySchema).length(24).optional(),
    stats: z
      .object({
        active: z.number().int().min(0),
        automatic: z.number().int().min(0),
        createdThirtyDays: z.number().int().min(0),
        embedded: z.number().int().min(0),
        explicit: z.number().int().min(0),
        knowledge: z.number().int().min(0),
        personal: z.number().int().min(0),
        preference: z.number().int().min(0),
        procedure: z.number().int().min(0),
        public: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

export type MemoryDashboardData = z.output<typeof memoryDashboardSchema>;
export type MemoryDay = MemoryDashboardData["days"][number];
export type MemoryCostDay = MemoryDashboardData["extractionDays"][number];

/** Load the viewer-scoped Memory dashboard summary. */
export function useMemoryDashboardData() {
  return useQuery({
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        memoryDashboardSchema,
        "/api/plugins/memory/dashboard",
        signal,
      ),
    queryKey: ["dashboard", "plugin-user-page", "memory", "summary"],
    retry: false,
  });
}
