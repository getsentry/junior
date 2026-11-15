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

const conversationFeedIncludeSchema = z.enum(["media"]);

/** Extra feed row content that a request asks for with `include=`. */
export type ConversationFeedInclude = z.infer<
  typeof conversationFeedIncludeSchema
>;

/** Query of `GET /api/conversations`. */
export const conversationFeedQuerySchema = z
  .object({
    actorEmail: z
      .string()
      .trim()
      .email()
      .transform((value) => value.toLowerCase())
      .optional(),
    codeRepositoryId: z.string().uuid().optional(),
    /** `nextCursor` from the previous page of the same feed. */
    cursor: z.string().min(1).max(500).optional(),
    /**
     * Extra row content that costs a query, comma separated: `media` for
     * each row's newest files. Rows show it only where the viewer sees
     * private content.
     */
    include: z
      .string()
      .default("")
      .transform((value) => [...new Set(value.split(",").filter(Boolean))])
      .pipe(z.array(conversationFeedIncludeSchema)),
    q: z.string().trim().max(200).optional(),
    status: z.enum(["active", "archived"]).default("active"),
  })
  .strict();

/** The most media a feed row lists. */
export const CONVERSATION_FEED_MEDIA_LIMIT = 3;

/**
 * One stored file of a Conversation that a feed row previews, newest first.
 * Read it through the Conversation's attachment route.
 */
export const conversationFeedMediaSchema = z
  .object({
    contentType: z.string(),
    filename: z.string(),
    id: z.string().min(1),
  })
  .strict();

export type ConversationFeedMedia = z.infer<typeof conversationFeedMediaSchema>;

/** A feed row, with its visible Threads nested under their parents. */
export type ConversationFeedItem = ConversationSummaryReport & {
  brief?: ConversationFeedBrief | undefined;
  media?: ConversationFeedMedia[] | undefined;
  threads?: ConversationFeedItem[] | undefined;
};

/**
 * A root in the feed, or one of its visible Threads. A Thread nests under
 * its nearest visible Thread ancestor, or under the root. Tasks never show.
 */
const conversationFeedItemSchema: z.ZodType<ConversationFeedItem> =
  conversationSummaryReportSchema.extend({
    brief: conversationFeedBriefSchema.optional(),
    /** Only with `include=media`. */
    media: z
      .array(conversationFeedMediaSchema)
      .max(CONVERSATION_FEED_MEDIA_LIMIT)
      .optional(),
    threads: z.lazy(() => z.array(conversationFeedItemSchema)).optional(),
  });

export const conversationFeedSchema = z
  .object({
    conversations: z.array(conversationFeedItemSchema),
    source: z.literal("conversation_index"),
    generatedAt: z.string(),
    /** Present when older conversations follow this page. */
    nextCursor: z.string().optional(),
  })
  .strict();

export type ConversationFeed = z.infer<typeof conversationFeedSchema>;
