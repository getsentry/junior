import { and, desc, eq } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorIdentities } from "@/db/schema";
import { isSlackDndActive } from "@/chat/slack/dnd";
import { getStateAdapter } from "@/chat/state/adapter";
import { createCache } from "@/chat/state/cache";

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

// Every caller in the same minute shares one answer per user, so a burst of
// pushes and settings reads makes one `dnd.info` call. A schedule change
// shows up within a minute.
const SLACK_PAUSE_BUCKET_MS = 60_000;

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
  const bucket = Math.floor(nowMs / SLACK_PAUSE_BUCKET_MS);
  const paused = await createCache(getStateAdapter(), "core").getOrLoad(
    `notifications:slack-paused:${userId}:${bucket}`,
    async () => {
      const slack = await linkedSlackUser(db, userId);
      const value = slack ? await isSlackDndActive(slack.userId, nowMs) : null;
      return { value: value ?? null, ttlMs: SLACK_PAUSE_BUCKET_MS };
    },
  );
  return paused ?? undefined;
}
