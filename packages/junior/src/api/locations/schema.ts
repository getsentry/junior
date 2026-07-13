import { z } from "zod";
import {
  actorIdentitySchema,
  conversationStatsItemSchema,
  conversationSummaryReportSchema,
} from "../conversations/schema";
import { dailyConversationActivitySchema } from "../activity";
import { juniorDestinationKindSchema } from "@/db/schema/destinations";

export const locationSummaryReportSchema = conversationStatsItemSchema
  .extend({
    id: z.string(),
    firstSeenAt: z.string(),
    kind: juniorDestinationKindSchema,
    lastSeenAt: z.string(),
    provider: z.string(),
    providerDestinationId: z.string(),
    visibility: z.literal("public"),
  })
  .strict();

export const locationActorSummaryReportSchema = conversationStatsItemSchema
  .extend({ actor: actorIdentitySchema })
  .strict();

export const locationDirectoryReportSchema = z
  .object({
    generatedAt: z.string(),
    locations: z.array(locationSummaryReportSchema),
    privateActivity: conversationStatsItemSchema,
    source: z.literal("conversation_index"),
  })
  .strict();

export const locationDetailReportSchema = locationSummaryReportSchema
  .extend({
    activityDays: z.array(dailyConversationActivitySchema),
    actors: z.array(locationActorSummaryReportSchema),
    generatedAt: z.string(),
    recentConversations: z.array(conversationSummaryReportSchema),
    source: z.literal("conversation_index"),
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

export type LocationSummaryReport = z.infer<typeof locationSummaryReportSchema>;
export type LocationActorSummaryReport = z.infer<
  typeof locationActorSummaryReportSchema
>;
export type LocationDirectoryReport = z.infer<
  typeof locationDirectoryReportSchema
>;
export type LocationDetailReport = z.infer<typeof locationDetailReportSchema>;
