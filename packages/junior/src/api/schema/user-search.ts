import * as z from "zod";

/** Users a search returns when the request sets no limit. */
export const USER_SEARCH_DEFAULT_LIMIT = 10;
/** The most Users one search returns. */
export const USER_SEARCH_MAX_LIMIT = 25;

/**
 * A search for Users to add to one Space or Conversation that the viewer
 * can read. Set exactly one of `spaceId` and `conversationId`.
 */
export const userSearchQuerySchema = z
  .object({
    conversationId: z.string().min(1).max(500).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(USER_SEARCH_MAX_LIMIT)
      .default(USER_SEARCH_DEFAULT_LIMIT),
    q: z.string().trim().min(1).max(100),
    spaceId: z.string().uuid().optional(),
  })
  .strict()
  .refine((query) => (query.spaceId === undefined) !== !query.conversationId, {
    message: "Set exactly one of spaceId and conversationId.",
  });

/**
 * One User that the people picker shows. `isMember` is true when they are
 * already a Member of the Space or a Participant of the Conversation.
 * `slackUserId` is set for a Conversation search, because Invite names a
 * person by their Slack account in its workspace.
 */
export const userSearchResultSchema = z
  .object({
    avatarUrl: z.string().optional(),
    email: z.string().min(1),
    fullName: z.string().optional(),
    isMember: z.literal(true).optional(),
    slackUserId: z.string().min(1).optional(),
    slackUserName: z.string().optional(),
    userId: z.string().min(1),
  })
  .strict();

export const userSearchReportSchema = z
  .object({ users: z.array(userSearchResultSchema) })
  .strict();

export type UserSearchQuery = z.output<typeof userSearchQuerySchema>;
export type UserSearchResult = z.infer<typeof userSearchResultSchema>;
export type UserSearchReport = z.infer<typeof userSearchReportSchema>;
