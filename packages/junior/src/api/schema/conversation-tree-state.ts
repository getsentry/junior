import * as z from "zod";

/**
 * What a Conversation and its child Conversations need, for one viewer.
 * See "Tree state" in `TERMINOLOGY.md`.
 */
export const conversationTreeStateSchema = z.enum([
  "needs_you",
  "working",
  "done",
]);

export type ConversationTreeState = z.output<
  typeof conversationTreeStateSchema
>;
