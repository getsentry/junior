import { readConversationStatsFromSql } from "./stats.query";
import { conversationStatsReportSchema } from "../schema/conversation";
import type { ConversationStatsReport } from "../schema/conversation";
import { defineApiRoute } from "../route";

/** Load aggregate conversation stats directly from durable SQL records. */
export async function readConversationStats(): Promise<ConversationStatsReport> {
  return conversationStatsReportSchema.parse(
    await readConversationStatsFromSql(),
  );
}

/** Serve aggregate conversation stats. */
export default defineApiRoute({
  method: "get",
  path: "/stats",
  responseSchema: conversationStatsReportSchema,
  handler: readConversationStats,
});
