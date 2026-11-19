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

const conversationFeedIncludeSchema = z.enum(["links", "media"]);

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
     * each row's newest files, `links` for web links from its recent
     * messages. Rows show them only where the viewer sees private content.
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

/** The most links a feed row lists. */
export const CONVERSATION_FEED_LINK_LIMIT = 3;

/**
 * The viewer's newest answer to a Review item that the Conversation added:
 * when it closed and the options they picked. A text answer has no choices.
 */
export const conversationFeedViewerAnswerSchema = z
  .object({
    choices: z.array(z.string()),
    closedAt: z.string().datetime(),
  })
  .strict();

export type ConversationFeedViewerAnswer = z.infer<
  typeof conversationFeedViewerAnswerSchema
>;

/** A feed row, with its visible Threads nested under their parents. */
export type ConversationFeedItem = ConversationSummaryReport & {
  brief?: ConversationFeedBrief | undefined;
  links?: string[] | undefined;
  media?: ConversationFeedMedia[] | undefined;
  threads?: ConversationFeedItem[] | undefined;
  viewerAnswer?: ConversationFeedViewerAnswer | undefined;
};

/**
 * A root in the feed, or one of its visible Threads. A Thread nests under
 * its nearest visible Thread ancestor, or under the root. Tasks never show.
 */
const conversationFeedItemSchema: z.ZodType<ConversationFeedItem> =
  conversationSummaryReportSchema.extend({
    brief: conversationFeedBriefSchema.optional(),
    /**
     * Web links from the Conversation's recent messages, newest first, for
     * the row to resolve into cards. URLs only: never message text. Only
     * with `include=links`.
     */
    links: z.array(z.url()).max(CONVERSATION_FEED_LINK_LIMIT).optional(),
    /** Only with `include=media`. */
    media: z
      .array(conversationFeedMediaSchema)
      .max(CONVERSATION_FEED_MEDIA_LIMIT)
      .optional(),
    threads: z.lazy(() => z.array(conversationFeedItemSchema)).optional(),
    /** Only on the viewer's own feed. */
    viewerAnswer: conversationFeedViewerAnswerSchema.optional(),
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

/**
 * Carries the content token of one feed page in both directions, like
 * `CONVERSATION_DETAIL_VERSION_HEADER` and for the same reason. A request
 * that sends the token of the page it holds gets 304 while the page is
 * unchanged.
 */
export const CONVERSATION_FEED_PAGE_VERSION_HEADER =
  "x-junior-feed-page-version";
