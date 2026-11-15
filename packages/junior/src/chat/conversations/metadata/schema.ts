import * as z from "zod";

/** Where a Conversation's work ended, as of its latest Conversation metadata. */
export const conversationOutcomeStatusSchema = z.enum([
  "in_progress",
  "answered",
  "done",
  "partial",
  "blocked",
  "abandoned",
]);

export type ConversationOutcomeStatus = z.output<
  typeof conversationOutcomeStatusSchema
>;
