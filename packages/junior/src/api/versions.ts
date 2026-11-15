import type { User } from "@sentry/junior-plugin-api";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { reviewItemsNeedingUserVersionQuery } from "@/chat/review-items/store";
import { juniorUsers } from "@/db/schema";
import { conversationVersionQuery } from "./conversations/detail-etag";
import { conversationFeedVersionQuery } from "./conversations/list";
import { personalSpendVersionQuery } from "./people/spend.query";
import type { Versions } from "./schema/versions";

/**
 * Read the change tokens of the dashboard reads in one statement, so one
 * cheap poll can tell which reads to refresh. The real endpoints still check
 * access. The Conversation token shows no more than its detail report does:
 * that report answers any viewer, with private content redacted.
 */
export async function readVersions(
  viewer: User,
  options: { conversationId?: string | undefined } = {},
): Promise<Versions> {
  const db = getDb();
  const [row] = await db
    .select({
      conversation: options.conversationId
        ? sql<
            string | null
          >`(${conversationVersionQuery(db, options.conversationId, viewer.id)})`
        : sql<null>`null`,
      conversations: sql<string>`(${conversationFeedVersionQuery(db, viewer.id)})`,
      reviewItems: sql<string>`(${reviewItemsNeedingUserVersionQuery(db, viewer.id)})`,
      spend: sql<string>`(${personalSpendVersionQuery(db, viewer.email, Date.now())})`,
    })
    // The viewer's row anchors the one-row select.
    .from(juniorUsers)
    .where(eq(juniorUsers.id, viewer.id));
  if (!row) throw new Error("Viewer user row is missing");
  return {
    ...(row.conversation ? { conversation: row.conversation } : undefined),
    conversations: row.conversations,
    reviewItems: row.reviewItems,
    spend: row.spend,
  };
}
