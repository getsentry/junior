import { z } from "zod";

export const archiveConversationBodySchema = z
  .object({ archived: z.boolean(), lastSeenAt: z.string().datetime() })
  .strict();

export const archiveConversationResponseSchema = z
  .object({ archivedAt: z.string().datetime().nullable() })
  .strict();

/** Viewer's auto-archive choice for one conversation. */
export const conversationAutoArchiveSchema = z
  .object({ autoArchive: z.boolean() })
  .strict();

/** Result of archiving all of the viewer's done conversations once. */
export const archiveDoneConversationsResponseSchema = z
  .object({ archived: z.number().int().nonnegative() })
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
