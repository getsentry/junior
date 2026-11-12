import type {
  PluginRegistration,
  PluginRunContext,
  PluginTaskContext,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { getConversationEventStore } from "@/chat/db";
import type { ConversationMessage } from "@/chat/state/conversation";
import { logInfo, setSpanAttributes } from "@/chat/logging";
import { findUserByEmailFromSql } from "@/chat/plugins/viewer";
import { isWithinNotificationSchedule } from "./schedule";
import { isPausedBySlack } from "./slack";
import { readNotificationSchedule } from "./store";
import { resolveNotificationTimezone } from "./timezone";
import {
  readWebPushConfig,
  sendPushNotificationToUser,
  type PushNotificationPayload,
} from "./web-push";

const PREVIEW_MAX_CHARS = 180;

/** Turn Markdown reply text into one short plain line for a notification. */
function notificationPreview(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > PREVIEW_MAX_CHARS
    ? `${plain.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`
    : plain;
}

/**
 * Return the stored reply of the Turn: the text that the person sees. The
 * run transcript has the raw model text, which can be a no-reply marker, and
 * does not say whether the reply was quiet.
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
 * Return the user to notify. The run context links Slack Actors to users. A
 * dashboard Actor carries the verified sign-in email, so read its user by
 * that email.
 */
async function recipientUserId(
  db: JuniorDatabase,
  run: PluginRunContext,
): Promise<string | undefined> {
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
  | "quiet"
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
 * Send a push notification to the Actor's user when a Turn finishes.
 *
 * Only Conversations without a Location qualify. A Conversation with a
 * Location, such as a Slack thread, already notifies people there.
 */
async function notifyReply(context: PluginTaskContext): Promise<void> {
  const config = readWebPushConfig();
  if (!config) return skip("not_configured");
  const run = await context.run.load();
  if (run.locationId) return skip("has_location");
  const url = getDashboardConversationLink(run.conversationId);
  if (!url) return skip("no_dashboard");
  const reply = await readTurnReply(run);
  if (!reply) return skip("no_reply");
  // A Quiet message notifies nobody, like in the Location.
  if (reply.meta?.quiet) return skip("quiet");
  const db = context.db as JuniorDatabase;
  const userId = await recipientUserId(db, run);
  if (!userId) return skip("no_user");

  const nowMs = Date.now();
  const schedule = await readNotificationSchedule(db, userId);
  const pausedBySlack =
    schedule.followSlack !== false
      ? await isPausedBySlack(db, userId, nowMs)
      : undefined;
  if (pausedBySlack) return skip("slack_paused");
  if (pausedBySlack === undefined) {
    const { timezone } = await resolveNotificationTimezone({
      db,
      nowMs,
      schedule,
      userId,
    });
    if (!isWithinNotificationSchedule(schedule, timezone, nowMs)) {
      return skip("outside_hours");
    }
  }

  // The payload holds only a short plain-text preview. Logs hold only counts.
  const payload: PushNotificationPayload = {
    body: notificationPreview(reply.text) || "New reply",
    tag: run.conversationId,
    title: (await readConversationTitle(db, run.conversationId)) ?? "Junior",
    url,
  };
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
