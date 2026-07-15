import { z } from "zod";

/** Stable, privacy-safe classification for a failed turn. */
export const conversationTurnFailureCodeSchema = z.enum([
  "agent_run_failed",
  "delivery_failed",
  "model_execution_failed",
  "persistence_failed",
]);

/** Failure classification persisted without raw provider or exception data. */
export type ConversationTurnFailureCode = z.output<
  typeof conversationTurnFailureCodeSchema
>;
