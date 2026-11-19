import type { User } from "@sentry/junior-plugin-api";
import { eq, sql } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import { reviewItemsNeedingUserVersionQuery } from "@/chat/review-items/store";
import { juniorUsers } from "@/db/schema";
import { conversationVersionQuery } from "./conversations/detail-etag";
import { conversationFeedVersionQuery } from "./conversations/list";
import { personalSpendVersionQuery } from "./people/spend.query";
import type { Versions } from "./schema/versions";

/**
 * Build a JSON object of each Conversation's tree token by id, with no entry
 * for a missing one. Each id is its own key lookup in the same statement.
 * Pairs join with `||`, because `jsonb_build_object` takes at most 100
 * arguments.
 */
function conversationDetailsVersionQuery(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  viewerId: string,
) {
  if (conversationIds.length === 0) {
    return sql<Record<string, string>>`'{}'::jsonb`;
  }
  const pairs = conversationIds.map(
    (conversationId) =>
      sql`jsonb_build_object(${conversationId}::text, (${conversationVersionQuery(db, conversationId, viewerId)}))`,
  );
  return sql<
    Record<string, string>
  >`jsonb_strip_nulls(${sql.join(pairs, sql` || `)})`;
}

/**
 * Read the change tokens of the dashboard reads in one statement, so one
 * cheap poll can tell which reads to refresh. The real endpoints still check
 * access. A Conversation token shows no more than its detail report does:
 * that report answers any viewer, with private content redacted. Its status
 * reads plan at a cost that starts JIT, which costs more than the read.
 */
export async function readVersions(
  viewer: User,
  options: { conversationIds: readonly string[] },
): Promise<Versions> {
  const [row] = await getSqlExecutor().readWithoutJit((db) =>
    db
      .select({
        conversationDetails: conversationDetailsVersionQuery(
          db,
          options.conversationIds,
          viewer.id,
        ),
        conversations: sql<string>`(${conversationFeedVersionQuery(db, viewer.id)})`,
        reviewItems: sql<string>`(${reviewItemsNeedingUserVersionQuery(db, viewer.id)})`,
        spend: sql<string>`(${personalSpendVersionQuery(db, viewer.email, Date.now())})`,
      })
      // The viewer's row anchors the one-row select.
      .from(juniorUsers)
      .where(eq(juniorUsers.id, viewer.id)),
  );
  if (!row) throw new Error("Viewer user row is missing");
  return row;
}
