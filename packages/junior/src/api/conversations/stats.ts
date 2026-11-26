import { createCachedReport } from "../cached-report";
import { readConversationStatsFromSql } from "./stats.query";
import { conversationStatsReportSchema } from "../schema/conversation-stats";

/** Load aggregate conversation stats from durable SQL records. */
export const readConversationStats = createCachedReport({
  freshMs: 5 * 60_000,
  keepMs: 60 * 60_000,
  key: "conversation-stats",
  read: readConversationStatsFromSql,
  refreshFailedEvent: "conversation_stats.refresh.failed",
  schema: conversationStatsReportSchema,
});
