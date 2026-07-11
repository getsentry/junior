import { readConversationStatsFromSql } from "./stats.query";
import type { ConversationStatsReport } from "./types";

/** Load aggregate conversation stats directly from durable SQL records. */
export async function readConversationStats(): Promise<ConversationStatsReport> {
  return readConversationStatsFromSql();
}

export type { ConversationStatsItem, ConversationStatsReport } from "./types";
