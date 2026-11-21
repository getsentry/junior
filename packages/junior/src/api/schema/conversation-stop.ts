import * as z from "zod";

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
    status: z
      .enum(["no_work", "requested"])
      .describe(
        "`requested` when the running turn was asked to stop. `no_work` when no turn was running. Child agents are stopped in both cases.",
      ),
    stoppedInboundMessageIds: z
      .array(z.string().min(1))
      .describe("Messages that waited for the turn and were dropped."),
    stoppedMessages: z
      .array(stoppedConversationMessageSchema)
      .describe("Your own dropped messages, with their text."),
  })
  .strict();

export type StopConversationTurnResponse = z.infer<
  typeof stopConversationTurnResponseSchema
>;
