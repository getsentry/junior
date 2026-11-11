import * as z from "zod";
import { briefOutcomeStatusSchema } from "@/chat/briefs/schema";
import {
  conversationSummaryReportSchema,
  type ConversationSummaryReport,
} from "./conversation";

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

/** A feed row, with its visible Threads nested under their parents. */
export type ConversationFeedItem = ConversationSummaryReport & {
  brief?: ConversationFeedBrief;
  threads?: ConversationFeedItem[];
};

/**
 * A root in the feed, or one of its visible Threads. A Thread nests under
 * its nearest visible Thread ancestor, or under the root. Tasks never show.
 */
const conversationFeedItemSchema: z.ZodType<ConversationFeedItem> =
  conversationSummaryReportSchema.extend({
    brief: conversationFeedBriefSchema.optional(),
    threads: z.lazy(() => z.array(conversationFeedItemSchema)).optional(),
  });

export const conversationFeedSchema = z
  .object({
    conversations: z.array(conversationFeedItemSchema),
    source: z.literal("conversation_index"),
    generatedAt: z.string(),
  })
  .strict();

export type ConversationFeed = z.infer<typeof conversationFeedSchema>;
