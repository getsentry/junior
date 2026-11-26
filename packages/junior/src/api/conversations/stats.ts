import { createCachedReport } from "../cached-report";
import { readConversationStatsFromSql } from "./stats.query";
import { conversationStatsReportSchema } from "../schema/conversation-stats";

/** Load aggregate conversation stats from durable SQL records. */
export const readConversationStats = createCachedReport({
  // The report has hour buckets, so a refresh every few minutes keeps the
  // current hour close to live.
  freshMs: 5 * 60_000,
  // A read scans the whole stats window. Until this ends, a request gets the
  // last report at once and starts a refresh, however long ago the last
  // request was.
  keepMs: 7 * 24 * 60 * 60_000,
  key: "conversation-stats",
  read: readConversationStatsFromSql,
  refreshFailedEvent: "conversation_stats.refresh.failed",
  schema: conversationStatsReportSchema,
});
