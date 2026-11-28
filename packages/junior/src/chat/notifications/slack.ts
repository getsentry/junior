import type { JuniorDatabase } from "@/db/db";
import { linkedSlackUser } from "@/chat/identities/sql";
import { isSlackDndActive } from "@/chat/slack/dnd";
import { isSlackUserActive } from "@/chat/slack/presence";
import { getStateAdapter } from "@/chat/state/adapter";
import { CACHE_LOAD_TIMEOUT_MS } from "@sentry/junior-plugin-api";
import { createCache } from "@/chat/state/cache";

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
      const value = slack
        ? await isSlackDndActive(
            slack.userId,
            nowMs,
            AbortSignal.timeout(CACHE_LOAD_TIMEOUT_MS),
          )
        : null;
      return { value: value ?? null, ttlMs: SLACK_PAUSE_BUCKET_MS };
    },
  );
  return paused ?? undefined;
}

/**
 * Return whether the user's linked Slack user is active in Slack now.
 * Return false when the user has no linked Slack user or Slack cannot
 * answer.
 */
export async function isActiveInSlack(
  db: JuniorDatabase,
  userId: string,
): Promise<boolean> {
  const slack = await linkedSlackUser(db, userId);
  return slack ? ((await isSlackUserActive(slack.userId)) ?? false) : false;
}
