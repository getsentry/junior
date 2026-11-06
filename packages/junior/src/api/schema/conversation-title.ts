import * as z from "zod";

/** Longest Conversation title that a rename can save. */
export const CONVERSATION_TITLE_MAX_LENGTH = 200;

/** A participant's new title for one Conversation. Every viewer sees it. */
export const renameConversationBodySchema = z
  .object({
    title: z.string().trim().min(1).max(CONVERSATION_TITLE_MAX_LENGTH),
  })
  .strict();

/** The stored title after the rename. */
export const renameConversationResponseSchema = z
  .object({ title: z.string().min(1) })
  .strict();

export type RenameConversationBody = z.infer<
  typeof renameConversationBodySchema
>;
export type RenameConversationResponse = z.infer<
  typeof renameConversationResponseSchema
>;
