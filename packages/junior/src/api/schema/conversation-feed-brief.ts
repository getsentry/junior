import * as z from "zod";
import { briefOutcomeStatusSchema } from "@/chat/briefs/schema";

/**
 * The part of a Conversation's latest Brief that a feed row shows: what the
 * work is about and how it stands.
 */
export const conversationFeedBriefSchema = z
  .object({
    intent: z.string(),
    status: briefOutcomeStatusSchema,
    summary: z.string(),
  })
  .strict();

export type ConversationFeedBrief = z.infer<typeof conversationFeedBriefSchema>;
