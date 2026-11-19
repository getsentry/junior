import { createCachedReport } from "../cached-report";
import { readConversationStatsFromSql } from "./stats.query";
import { conversationStatsReportSchema } from "../schema/conversation-stats";

/** Load aggregate conversation stats from durable SQL records. */
export const readConversationStats = createCachedReport({
  key: "conversation-stats",
  read: readConversationStatsFromSql,
  refreshFailedEvent: "conversation_stats.refresh.failed",
  schema: conversationStatsReportSchema,
});
