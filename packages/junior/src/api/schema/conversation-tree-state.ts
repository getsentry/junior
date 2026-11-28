import * as z from "zod";

/**
 * What a Conversation and its child Conversations need, for one viewer.
 * See "Viewer state" in `TERMINOLOGY.md`.
 */
export const conversationTreeStateSchema = z.enum([
  "needs_input",
  "working",
  "done",
]);

export type ConversationTreeState = z.output<
  typeof conversationTreeStateSchema
>;
