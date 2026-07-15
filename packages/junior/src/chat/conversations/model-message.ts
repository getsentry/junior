import { z } from "zod";

/** Junior-owned model-continuity shape; provider validation belongs to adapters. */
export const conversationModelMessageSchema = z
  .object({ role: z.string() })
  .passthrough()
  .transform((value) => value as { role: string });

/** Opaque model-continuity message stored by Junior-owned durable state. */
export type ConversationModelMessage = z.output<
  typeof conversationModelMessageSchema
>;
