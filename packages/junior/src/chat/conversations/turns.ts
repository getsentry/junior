import { z } from "zod";

export const newConversationTurnSchema = z
  .object({
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
    startingSeq: z.number().int().nonnegative(),
  })
  .strict();

export type NewConversationTurn = z.output<typeof newConversationTurnSchema>;

export const conversationTurnSchema = newConversationTurnSchema.extend({
  startingModelId: z.string().min(1),
});

export type ConversationTurn = z.output<typeof conversationTurnSchema>;

/** Persist and read durable conversation turn boundaries. */
export interface ConversationTurnStore {
  /** Record or return a turn start without moving an existing boundary. */
  recordStart(turn: NewConversationTurn): Promise<ConversationTurn>;
  /** Read one durable turn by its conversation-scoped identity. */
  get(
    conversationId: string,
    turnId: string,
  ): Promise<ConversationTurn | undefined>;
}
