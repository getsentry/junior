import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { fetchDashboardJson } from "../../http";

const memoryDaySchema = z
  .object({
    date: z.iso.date(),
    private: z.number().int().min(0),
    public: z.number().int().min(0),
  })
  .strict();

const memoryCostDaySchema = z
  .object({
    costUsd: z.number().finite().min(0),
    date: z.iso.date(),
    events: z.number().int().min(0),
  })
  .strict();

export const memoryDashboardSchema = z
  .object({
    days: z.array(memoryDaySchema).length(90),
    extractionDays: z.array(memoryCostDaySchema).length(90),
    generatedAt: z.iso.datetime(),
    recallDays: z.array(memoryCostDaySchema).length(90),
    stats: z
      .object({
        active: z.number().int().min(0),
        automatic: z.number().int().min(0),
        createdThirtyDays: z.number().int().min(0),
        embedded: z.number().int().min(0),
        explicit: z.number().int().min(0),
        knowledge: z.number().int().min(0),
        private: z.number().int().min(0),
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
