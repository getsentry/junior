import type {
  PluginRegistration,
  PluginRunContext,
  PluginTaskContext,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { findUserByEmailFromSql } from "@/chat/plugins/viewer";
import { isWithinNotificationSchedule } from "./schedule";
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

function lastAssistantText(run: PluginRunContext): string | undefined {
  for (let index = run.transcript.length - 1; index >= 0; index -= 1) {
    const entry = run.transcript[index];
    if (entry?.type === "message" && entry.role === "assistant") {
      return entry.text;
    }
  }
  return undefined;
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

function skip(context: PluginTaskContext, reason: string): void {
  context.log.info("Reply notification skipped", { reason });
}

/**
 * Send a phone notification to the Actor's user when a Turn finishes.
 *
 * Only Conversations without a Location qualify. A Conversation with a
 * Location, such as a Slack thread, already notifies people there.
 */
async function notifyReply(context: PluginTaskContext): Promise<void> {
  const config = readWebPushConfig();
  if (!config) return skip(context, "not_configured");
  const run = await context.run.load();
  if (run.locationId) return skip(context, "has_location");
  const url = getDashboardConversationLink(run.conversationId);
  if (!url) return skip(context, "no_dashboard");
  const reply = lastAssistantText(run);
  if (!reply) return skip(context, "no_reply");
  const db = context.db as JuniorDatabase;
  const userId = await recipientUserId(db, run);
  if (!userId) return skip(context, "no_user");

  const nowMs = Date.now();
  const schedule = await readNotificationSchedule(db, userId);
  const { timezone } = await resolveNotificationTimezone({
    db,
    nowMs,
    schedule,
    userId,
  });
  if (!isWithinNotificationSchedule(schedule, timezone, nowMs)) {
    return skip(context, "outside_hours");
  }

  const payload: PushNotificationPayload = {
    body: notificationPreview(reply) || "New reply",
    tag: run.conversationId,
    title: (await readConversationTitle(db, run.conversationId)) ?? "Junior",
    url,
  };
  await sendPushNotificationToUser({ config, db, payload, userId });
}

/** Core task that sends reply notifications to installed dashboard apps. */
export const notificationsTaskRegistration: PluginRegistration = {
  manifest: {
    name: "notifications",
    displayName: "Notifications",
    description: "Phone notifications for dashboard replies",
  },
  tasks: {
    notifyReply: {
      async run(context) {
        await notifyReply(context);
      },
    },
  },
};
