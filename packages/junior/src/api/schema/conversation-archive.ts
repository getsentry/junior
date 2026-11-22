import * as z from "zod";

/**
 * Archive or restore one conversation. `applyToChildren` applies to a child
 * only: archive refuses while a descendant is unarchived unless it is true,
 * and restore also restores the descendants archived with the child when it
 * is true. A root archive is per viewer and writes no child rows.
 */
export const archiveConversationBodySchema = z
  .object({
    applyToChildren: z
      .boolean()
      .optional()
      .describe(
        "On archive, true also archives every child of this conversation at any depth; without it, the archive fails while any of its children is not archived. On restore, true also restores the children that were archived with this conversation.",
      ),
    archived: z
      .boolean()
      .default(true)
      .describe("False restores an archived conversation."),
    lastSeenAt: z
      .string()
      .datetime()
      .describe(
        "`lastSeenAt` from searchConversations or getConversation. The archive fails when the conversation has newer activity.",
      ),
  })
  .strict();

export const archiveConversationResponseSchema = z
  .object({
    archivedAt: z
      .string()
      .datetime()
      .nullable()
      .describe("Null when the conversation is not archived."),
  })
  .strict();

/** Viewer's auto-archive choice for one conversation. */
export const conversationAutoArchiveSchema = z
  .object({
    autoArchive: z
      .boolean()
      .describe(
        "True lets auto-archive archive the conversation for everyone after its work is done. False keeps it from auto-archive for everyone.",
      ),
  })
  .strict();

/** Result of archiving all of the viewer's done conversations once. */
export const archiveDoneConversationsResponseSchema = z
  .object({
    archived: z
      .number()
      .int()
      .nonnegative()
      .describe("Conversations archived."),
  })
  .strict();

export type ArchiveConversationBody = z.infer<
  typeof archiveConversationBodySchema
>;
export type ArchiveConversationResponse = z.infer<
  typeof archiveConversationResponseSchema
>;
export type ConversationAutoArchive = z.infer<
  typeof conversationAutoArchiveSchema
>;
