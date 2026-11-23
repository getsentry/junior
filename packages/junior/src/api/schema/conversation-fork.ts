import * as z from "zod";

/** Body of a request to fork a Conversation at one assistant reply. */
export const forkConversationBodySchema = z
  .object({
    /** Assistant reply that ends the copied history. */
    messageId: z.string().min(1).max(500),
    idempotencyKey: z.string().trim().min(1).max(200),
    /** Start a hidden, read-only Quick question about this reply text. */
    quickQuestion: z
      .object({ quote: z.string().trim().min(1).max(4_000) })
      .strict()
      .optional(),
  })
  .strict();

/** The Conversation that a fork made. */
export const forkConversationResponseSchema = z
  .object({ conversationId: z.string() })
  .strict();

export type ForkConversationBody = z.infer<typeof forkConversationBodySchema>;
