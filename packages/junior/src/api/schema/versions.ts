import * as z from "zod";

/** The most Conversations that one versions read gives tokens for. */
export const VERSIONS_CONVERSATION_LIMIT = 50;

/**
 * `GET /api/versions` sets this header when `GET /api/versions/stream` can
 * push the same tokens, so a dashboard opens the stream only when it works.
 */
export const VERSIONS_STREAM_HEADER = "x-junior-versions-stream";

/**
 * The SSE event that the versions stream sends while no token moves. A
 * `Versions` object comes as a plain `message` event.
 */
export const VERSIONS_STREAM_KEEPALIVE_EVENT = "keepalive";

export const versionsQuerySchema = z
  .object({
    /**
     * The Conversations on screen, comma separated. Their tokens come back
     * in `conversationDetails`.
     */
    conversationIds: z
      .string()
      .default("")
      .transform((value) => [...new Set(value.split(",").filter(Boolean))])
      .pipe(
        z.array(z.string().min(1).max(200)).max(VERSIONS_CONVERSATION_LIMIT),
      ),
  })
  .strict();

/**
 * Opaque change tokens for the dashboard reads that refresh by themselves.
 * A token changes when the read it covers can change. Compare a token only
 * with an earlier token of the same field.
 */
export const versionsSchema = z
  .object({
    /**
     * Tree token of each requested Conversation by id, the same value as
     * its detail report's `CONVERSATION_VERSION_HEADER`. A Conversation
     * that does not exist has no entry.
     */
    conversationDetails: z.record(z.string(), z.string().min(1)),
    /**
     * The viewer's Conversation feed. It lists a short token for each
     * feed-row input as `name:token`, separated by spaces, so the dashboard
     * can record which inputs moved it.
     */
    conversations: z.string().min(1),
    /** Open Inbox items that need the viewer. */
    inboxItems: z.string().min(1),
    /** The viewer's rolling model spend. */
    spend: z.string().min(1),
  })
  .strict();

export type Versions = z.output<typeof versionsSchema>;
