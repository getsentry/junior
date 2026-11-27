import * as z from "zod";

/** Users a search returns when the request sets no limit. */
export const USER_SEARCH_DEFAULT_LIMIT = 10;
/** The most Users one search returns. */
export const USER_SEARCH_MAX_LIMIT = 25;

/** A search for Users to add to one Conversation that the viewer can read. */
export const userSearchQuerySchema = z
  .object({
    conversationId: z.string().min(1).max(500),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(USER_SEARCH_MAX_LIMIT)
      .default(USER_SEARCH_DEFAULT_LIMIT),
    q: z.string().trim().min(1).max(100),
  })
  .strict();

/**
 * One User that the people picker shows. `isMember` is true when they are
 * already a Participant of the Conversation. Invite names them by `userId`.
 */
export const userSearchResultSchema = z
  .object({
    avatarUrl: z.string().optional(),
    email: z.string().min(1),
    fullName: z.string().optional(),
    isMember: z.literal(true).optional(),
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
