import * as z from "zod";

import { briefOutcomeStatusSchema } from "@/chat/briefs/schema";

/**
 * A glance at a Conversation's latest Brief version, for feed rows: what the
 * work is about and how it ended. The feed reads it from the newest row in
 * `junior_conversation_briefs`; it adds no column.
 */
export const conversationBriefGlanceSchema = z
  .object({
    intent: z.string(),
    status: briefOutcomeStatusSchema,
    summary: z.string(),
  })
  .strict();

export type ConversationBriefGlance = z.infer<
  typeof conversationBriefGlanceSchema
>;
