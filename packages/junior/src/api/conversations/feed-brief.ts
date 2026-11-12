import { desc, eq, inArray, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationBriefs, juniorConversations } from "@/db/schema";
import {
  conversationFeedBriefSchema,
  type ConversationFeedBrief,
} from "../schema/conversation-feed";

/**
 * Read the latest Brief version of each Conversation on a feed page, in one
 * query. A lateral limit reads one row per Conversation from the
 * (conversation, version) key, so long Brief histories do not slow the feed.
 * Callers show the result only when the viewer can see private content.
 */
export async function readConversationFeedBriefs(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationFeedBrief>> {
  if (conversationIds.length === 0) return new Map();

  const content = juniorConversationBriefs.content;
  const latest = db
    .select({
      intent: sql<string>`${content}->>'intent'`.as("intent"),
      status: sql<string>`${content}->'outcome'->>'status'`.as("status"),
      summary: sql<string>`${content}->>'summary'`.as("summary"),
    })
    .from(juniorConversationBriefs)
    .where(
      eq(
        juniorConversationBriefs.conversationId,
        juniorConversations.conversationId,
      ),
    )
    .orderBy(desc(juniorConversationBriefs.version))
    .limit(1)
    .as("latest_brief");
  const rows = await db
    .select({
      conversationId: juniorConversations.conversationId,
      intent: latest.intent,
      status: latest.status,
      summary: latest.summary,
    })
    .from(juniorConversations)
    .innerJoinLateral(latest, sql`true`)
    .where(inArray(juniorConversations.conversationId, conversationIds));

  return new Map(
    rows.map(({ conversationId, ...brief }) => [
      conversationId,
      conversationFeedBriefSchema.parse(brief),
    ]),
  );
}
