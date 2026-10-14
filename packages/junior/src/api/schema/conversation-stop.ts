import { z } from "zod";

/** One queued web message from the viewer that a stop removed. */
const stoppedConversationMessageSchema = z
  .object({
    inboundMessageId: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

/**
 * Result of stopping the active Turn.
 *
 * `stoppedInboundMessageIds` lists every queued human message the stop
 * removes. `stoppedMessages` holds only the viewer's own web text, so the
 * dashboard can return it to the composer.
 */
export const stopConversationTurnResponseSchema = z
  .object({
    conversationId: z.string().min(1),
    status: z.enum(["no_work", "requested"]),
    stoppedInboundMessageIds: z.array(z.string().min(1)),
    stoppedMessages: z.array(stoppedConversationMessageSchema),
  })
  .strict();

export type StopConversationTurnResponse = z.infer<
  typeof stopConversationTurnResponseSchema
>;
