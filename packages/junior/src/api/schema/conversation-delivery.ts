import * as z from "zod";

/** Pause or resume Delivery of a root's Event Turn replies to its Location. */
export const conversationDeliveryBodySchema = z
  .object({ paused: z.boolean() })
  .strict();

/** The Delivery state after the change. */
export const conversationDeliveryResponseSchema = z
  .object({ paused: z.boolean() })
  .strict();

export type ConversationDeliveryBody = z.infer<
  typeof conversationDeliveryBodySchema
>;
export type ConversationDeliveryResponse = z.infer<
  typeof conversationDeliveryResponseSchema
>;
