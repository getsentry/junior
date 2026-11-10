import { desc, inArray, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationBriefs } from "@/db/schema";
import {
  conversationFeedBriefSchema,
  type ConversationFeedBrief,
} from "../schema/conversation-feed-brief";

/**
 * Read the latest Brief version of each Conversation on a feed page, in one
 * query. It walks `junior_conversation_briefs_conversation_version_idx`.
 * Callers show the result only when the viewer can see private content.
 */
export async function readConversationFeedBriefs(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationFeedBrief>> {
  if (conversationIds.length === 0) return new Map();

  const content = juniorConversationBriefs.content;
  const rows = await db
    .selectDistinctOn([juniorConversationBriefs.conversationId], {
      conversationId: juniorConversationBriefs.conversationId,
      intent: sql<string>`${content}->>'intent'`.as("intent"),
      status: sql<string>`${content}->'outcome'->>'status'`.as("status"),
      summary: sql<string>`${content}->>'summary'`.as("summary"),
    })
    .from(juniorConversationBriefs)
    .where(inArray(juniorConversationBriefs.conversationId, conversationIds))
    .orderBy(
      juniorConversationBriefs.conversationId,
      desc(juniorConversationBriefs.version),
    );

  return new Map(
    rows.map(({ conversationId, ...brief }) => [
      conversationId,
      conversationFeedBriefSchema.parse(brief),
    ]),
  );
}
