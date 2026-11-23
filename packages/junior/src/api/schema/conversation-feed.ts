import * as z from "zod";
import {
  conversationSummaryReportSchema,
  type ConversationSummaryReport,
} from "./conversation";

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
 * The most Threads a feed row lists, at any depth. Real roots hold far
 * fewer, so this only bounds the response; a row past it says how many it
 * left out, and its detail lists them all.
 */
export const CONVERSATION_FEED_THREAD_LIMIT = 100;

/**
 * The most waiting rows from outside the page that the first page adds.
 * Real feeds wait on far fewer at once. The rest come on later pages, by
 * activity like any other row.
 */
export const CONVERSATION_FEED_WAITING_LIMIT = 50;

/**
 * The viewer's newest answer to an Inbox item that the Conversation added:
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
  links?: string[] | undefined;
  media?: ConversationFeedMedia[] | undefined;
  omittedThreadCount?: number | undefined;
  threads?: ConversationFeedItem[] | undefined;
  viewerAnswer?: ConversationFeedViewerAnswer | undefined;
};

/**
 * A root in the feed, or one of its visible Threads. A Thread nests under
 * its nearest visible Thread ancestor, or under the root. Tasks never show.
 */
const conversationFeedItemSchema: z.ZodType<ConversationFeedItem> =
  conversationSummaryReportSchema.extend({
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
    /**
     * Threads that `CONVERSATION_FEED_THREAD_LIMIT` left out of `threads`.
     * Only on a root, and only when the cap cut some.
     */
    omittedThreadCount: z.number().int().positive().optional(),
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
    /**
     * Present when `CONVERSATION_FEED_WAITING_LIMIT` cut the waiting rows
     * that this first page adds from outside it. The rest come on later
     * pages.
     */
    waitingRowsTruncated: z.literal(true).optional(),
  })
  .strict();

export type ConversationFeed = z.infer<typeof conversationFeedSchema>;
