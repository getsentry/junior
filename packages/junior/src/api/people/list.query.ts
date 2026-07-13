import { eq, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import {
  conversationActiveDaysColumn,
  conversationAggregateColumns,
  conversationRangeColumns,
} from "../conversations/aggregate";
import type {
  ActorDirectoryReport,
  ActorIdentity,
  ActorSummaryReport,
} from "./schema";
import { verifiedActorWhere } from "./shared";

/** Load the complete People directory with grouping and metrics owned by SQL. */
export async function readPeopleListFromSql(): Promise<ActorDirectoryReport> {
  const nowMs = Date.now();
  const rows = await getDb()
    .select({
      email: juniorUsers.primaryEmailNormalized,
      fullName: juniorUsers.displayName,
      slackUserId: sql<
        string | null
      >`MAX(${juniorIdentities.providerSubjectId})`,
      slackUserName: sql<string | null>`MAX(${juniorIdentities.handle})`,
      activeDays: conversationActiveDaysColumn(),
      ...conversationAggregateColumns(),
      ...conversationRangeColumns(),
    })
    .from(juniorConversations)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(verifiedActorWhere())
    .groupBy(juniorUsers.primaryEmailNormalized, juniorUsers.displayName);

  const people: ActorSummaryReport[] = rows.map((row) => {
    const actor: ActorIdentity & { email: string } = {
      email: row.email,
      ...(row.fullName ? { fullName: row.fullName } : {}),
      ...(row.slackUserId ? { slackUserId: row.slackUserId } : {}),
      ...(row.slackUserName ? { slackUserName: row.slackUserName } : {}),
    };
    return {
      active: row.active,
      activeDays: row.activeDays,
      conversations: row.conversations,
      durationMs: row.durationMs,
      failed: row.failed,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      actor,
      ...(row.tokens !== null ? { tokens: row.tokens } : {}),
    };
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    people: people.sort(
      (left, right) =>
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
        right.conversations - left.conversations ||
        left.actor.email.localeCompare(right.actor.email),
    ),
    source: "conversation_index",
  };
}
