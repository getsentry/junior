import type {
  PluginRegistration,
  PluginRunContext,
  PluginTaskContext,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations, juniorIdentities } from "@/db/schema";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { getConversationEventStore } from "@/chat/db";
import {
  clearInboxItemDeliveries,
  recordReplyNoticePush,
} from "@/chat/inbox-items/deliveries";
import { upsertReplyNotice } from "@/chat/inbox-items/reply-notice";
import { isInboxItemOpen } from "@/chat/inbox-items/store";
import type { ConversationMessage } from "@/chat/state/conversation";
import { logInfo, setSpanAttributes } from "@/chat/logging";
import { findUserByEmailFromSql } from "@/chat/plugins/viewer";
import { readNotificationPause } from "./pause";
import { notificationPreview } from "./preview";
import {
  readWebPushConfig,
  sendPushNotificationToUser,
  type PushNotificationPayload,
} from "./web-push";
import { botConfig } from "@/chat/config";

/**
 * Return the stored reply of the Turn: the text that the person sees. The
 * run transcript has the raw model text, which can be a no-reply marker.
 */
async function readTurnReply(
  run: PluginRunContext,
): Promise<ConversationMessage | undefined> {
  const prefix = `${run.runId}:assistant:`;
  const messages = projectConversationMessages(
    await getConversationEventStore().loadMessageHistory(run.conversationId),
  );
  return messages
    .filter(
      (message) =>
        message.role === "assistant" && message.id.startsWith(prefix),
    )
    .at(-1);
}

/**
 * Return the starter: the User of the root's actor. Only a root runs
 * session tasks, so the run's Conversation is the root. A root from before
 * Conversations stored their actor has none, so the Actor of the run, who
 * sent the message, stands in. A dashboard Actor carries the verified
 * sign-in email, so read its user by that email.
 */
async function starterUserId(
  db: JuniorDatabase,
  run: PluginRunContext,
): Promise<string | undefined> {
  const [root] = await db
    .select({ userId: juniorIdentities.userId })
    .from(juniorConversations)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .where(eq(juniorConversations.conversationId, run.conversationId))
    .limit(1);
  if (root?.userId) return root.userId;
  if (run.actorUserId) return run.actorUserId;
  if (run.actor?.platform !== "web" || !run.actor.email) return undefined;
  return (await findUserByEmailFromSql(db, run.actor.email))?.id;
}

async function readConversationTitle(
  db: JuniorDatabase,
  conversationId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ title: juniorConversations.title })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return rows[0]?.title?.trim() || undefined;
}

type SkipReason =
  | "has_location"
  | "no_dashboard"
  | "no_reply"
  | "no_user"
  | "not_configured"
  | "outside_hours"
  | "read"
  | "slack_paused";

function skip(reason: SkipReason): void {
  setSpanAttributes({
    "app.notification.outcome": "skipped",
    "app.notification.skip_reason": reason,
  });
  logInfo("notification.reply.skipped", {
    "app.notification.skip_reason": reason,
  });
}

/**
 * Turn the reply of a finished Turn into the reply notice of its starter,
 * and push the notice to them.
 *
 * Only Conversations without a Location qualify. A Conversation with a
 * Location, such as a Slack thread, already notifies people there.
 */
async function notifyReply(context: PluginTaskContext): Promise<void> {
  const run = await context.run.load();
  if (run.locationId) return skip("has_location");
  const reply = await readTurnReply(run);
  if (!reply) return skip("no_reply");
  const db = context.db as JuniorDatabase;
  const userId = await starterUserId(db, run);
  if (!userId) return skip("no_user");

  // The notice and the push hold only a short plain-text preview. Logs
  // hold only counts.
  const title =
    (await readConversationTitle(db, run.conversationId)) ?? botConfig.userName;
  const body = notificationPreview(reply.text) || "New reply";
  const itemId = await upsertReplyNotice(db, {
    body,
    conversationId: run.conversationId,
    nowMs: Date.now(),
    starterUserId: userId,
    title,
    turnId: run.runId,
  });

  const config = readWebPushConfig();
  if (!config) return skip("not_configured");
  const url = getDashboardConversationLink(run.conversationId);
  if (!url) return skip("no_dashboard");
  const nowMs = Date.now();
  const pause = await readNotificationPause(db, userId, nowMs);
  await recordReplyNoticePush(db, {
    itemId,
    nowMs,
    skipReason: pause,
    userId,
  });
  if (pause) return skip(pause);
  // The starter can read the reply before the record. That close cleared
  // no row, so clear it now and send nothing.
  if (!(await isInboxItemOpen(db, itemId))) {
    await clearInboxItemDeliveries(db, [itemId], Date.now());
    return skip("read");
  }

  // The notice's tag replaces the push of an earlier reply on the device,
  // and the push goes away when the starter reads the reply.
  const payload: PushNotificationPayload = { body, tag: itemId, title, url };
  const result = await sendPushNotificationToUser({
    config,
    db,
    kind: "reply",
    payload,
    userId,
  });
  // The wait that the user sees: from the completed Turn to the end of the
  // pushes. A queued task can run on another host, so a negative value is
  // clock skew and is left out.
  const replyLagMs = Date.now() - run.completedAtMs;
  setSpanAttributes({
    "app.notification.outcome": "sent",
    "app.notification.devices": result.devices,
    "app.notification.delivered": result.delivered,
    "app.notification.failed": result.failed,
    "app.notification.removed": result.removed,
    ...(replyLagMs >= 0
      ? { "app.notification.reply_lag_ms": Math.round(replyLagMs) }
      : undefined),
  });
}

/** Core task that sends reply notifications to installed dashboard apps. */
export const notificationsTaskRegistration: PluginRegistration = {
  manifest: {
    name: "notifications",
    displayName: "Notifications",
    description: "Push notifications for dashboard replies",
  },
  tasks: {
    notifyReply: {
      async run(context) {
        await notifyReply(context);
      },
    },
  },
};
