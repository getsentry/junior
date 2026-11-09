import { and, desc, eq } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorIdentities } from "@/db/schema";
import { isSlackDndActive } from "@/chat/slack/dnd";

/** Return the Slack user most recently linked to a Junior user. */
export async function linkedSlackUser(
  db: JuniorDatabase,
  userId: string,
): Promise<{ teamId: string; userId: string } | undefined> {
  const rows = await db
    .select({
      teamId: juniorIdentities.providerTenantId,
      slackUserId: juniorIdentities.providerSubjectId,
    })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.userId, userId),
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.provider, "slack"),
      ),
    )
    .orderBy(desc(juniorIdentities.updatedAt))
    .limit(1);
  const row = rows[0];
  return row?.teamId
    ? { teamId: row.teamId, userId: row.slackUserId }
    : undefined;
}

/**
 * Return whether the user's Slack notification schedule pauses notifications
 * now. Return undefined when the user has no linked Slack user or Slack
 * cannot answer.
 */
export async function isPausedBySlack(
  db: JuniorDatabase,
  userId: string,
  nowMs: number,
): Promise<boolean | undefined> {
  const slack = await linkedSlackUser(db, userId);
  return slack ? await isSlackDndActive(slack.userId, nowMs) : undefined;
}
