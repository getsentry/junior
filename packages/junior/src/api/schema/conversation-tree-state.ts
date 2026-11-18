import * as z from "zod";

/**
 * What a Conversation and its child Conversations wait on, for one viewer.
 * See "Tree state" in `TERMINOLOGY.md`. Unset when nothing applies.
 */
export const conversationTreeStateSchema = z.enum([
  "needs_you",
  "working",
  "waiting",
]);

export type ConversationTreeState = z.output<
  typeof conversationTreeStateSchema
>;
