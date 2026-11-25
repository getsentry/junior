import type { User } from "@sentry/junior-plugin-api";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import { inboxItemsNeedingUserVersionQuery } from "@/chat/inbox-items/waiting";
import { juniorUsers } from "@/db/schema";
import { conversationVersionsQuery } from "../conversations/detail-etag";
import { conversationFeedVersionQuery } from "../conversations/list";
import { personalSpendVersionQuery } from "../people/spend.query";
import type { Versions } from "../schema/versions";

/**
 * Build a JSON object of each Conversation's tree token by id, with no entry
 * for a missing one. The tokens come from one grouped pass over all the ids.
 */
function conversationDetailsVersionQuery(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  viewerId: string,
) {
  if (conversationIds.length === 0) {
    return sql<Record<string, string>>`'{}'::jsonb`;
  }
  const versions = conversationVersionsQuery(db, conversationIds, viewerId).as(
    "conversation_versions",
  );
  const byId = db
    .select({
      byId: sql`coalesce(jsonb_object_agg(${versions.conversationId}, ${versions.version}), '{}'::jsonb)`,
    })
    .from(versions);
  return sql<Record<string, string>>`(${byId})`;
}

/**
 * Read the change tokens of the dashboard reads in one statement, so one
 * cheap poll can tell which reads to refresh. The real endpoints still check
 * access. A Conversation token shows no more than its detail report does:
 * that report answers any viewer, with private content redacted.
 */
export async function readVersions(
  viewer: User,
  options: { conversationIds: readonly string[] },
): Promise<Versions> {
  const db = getDb();
  const [row] = await db
    .select({
      conversationDetails: conversationDetailsVersionQuery(
        db,
        options.conversationIds,
        viewer.id,
      ),
      conversations: sql<string>`(${conversationFeedVersionQuery(db, viewer.id)})`,
      inboxItems: sql<string>`(${inboxItemsNeedingUserVersionQuery(db, viewer.id)})`,
      spend: sql<string>`(${personalSpendVersionQuery(db, viewer.email, Date.now())})`,
    })
    // The viewer's row anchors the one-row select.
    .from(juniorUsers)
    .where(eq(juniorUsers.id, viewer.id));
  if (!row) throw new Error("Viewer user row is missing");
  return row;
}
