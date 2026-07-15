import { readConversationStatsFromSql } from "./stats.query";
import { conversationStatsReportSchema } from "./schema";
import type { ConversationStatsReport } from "./schema";
import type { ApiRoute } from "../route";

/** Load aggregate conversation stats directly from durable SQL records. */
export async function readConversationStats(): Promise<ConversationStatsReport> {
  return conversationStatsReportSchema.parse(
    await readConversationStatsFromSql(),
  );
}

/** Serve aggregate conversation stats. */
export default {
  method: "get",
  path: "/stats",
  handler: async () => Response.json(await readConversationStats()),
} satisfies ApiRoute;
