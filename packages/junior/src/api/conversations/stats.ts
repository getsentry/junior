import { readConversationStatsFromSql } from "./stats.query";
import { conversationStatsReportSchema } from "./schema";
import type { ConversationStatsReport } from "./schema";

/** Load aggregate conversation stats directly from durable SQL records. */
export async function readConversationStats(): Promise<ConversationStatsReport> {
  return conversationStatsReportSchema.parse(
    await readConversationStatsFromSql(),
  );
}
