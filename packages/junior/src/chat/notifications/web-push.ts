import webPush, { WebPushError } from "web-push";
import type { JuniorDatabase } from "@/db/db";
import { logInfo, logWarn } from "@/chat/logging";
import { deletePushSubscriptionsById, listPushSubscriptions } from "./store";

/** VAPID settings that Junior uses to sign Web Push requests. */
export interface WebPushConfig {
  privateKey: string;
  publicKey: string;
  subject: string;
}

/** The JSON body that the dashboard service worker shows. */
export interface PushNotificationPayload {
  body: string;
  /** Replaces an older notification with the same tag on the device. */
  tag: string;
  title: string;
  /** Dashboard URL to open when the user taps the notification. */
  url: string;
}

/** Keep a reply notification for 12 hours while the device is offline. */
const PUSH_TTL_SECONDS = 12 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;

function subjectFromBaseUrl(): string | undefined {
  const baseUrl = process.env.JUNIOR_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  return /^https?:\/\//.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
}

/**
 * Read VAPID settings from the environment. Phone notifications are off when
 * either key is missing.
 */
export function readWebPushConfig(): WebPushConfig | undefined {
  const publicKey = process.env.JUNIOR_WEB_PUSH_PUBLIC_KEY?.trim();
  const privateKey = process.env.JUNIOR_WEB_PUSH_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return undefined;
  const subject =
    process.env.JUNIOR_WEB_PUSH_SUBJECT?.trim() || subjectFromBaseUrl();
  if (!subject) return undefined;
  return { privateKey, publicKey, subject };
}

/**
 * Send one notification to every browser of one user. A failed browser does
 * not stop the others, and the task is not retried, so a retry cannot send
 * duplicates. Subscriptions that the push service reports as gone are deleted.
 */
export async function sendPushNotificationToUser(args: {
  config: WebPushConfig;
  db: JuniorDatabase;
  payload: PushNotificationPayload;
  userId: string;
}): Promise<{ delivered: number; failed: number; removed: number }> {
  const subscriptions = await listPushSubscriptions(args.db, args.userId);
  const body = JSON.stringify(args.payload);
  const gone: string[] = [];
  let delivered = 0;
  let failed = 0;
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(subscription, body, {
          TTL: PUSH_TTL_SECONDS,
          contentEncoding: "aes128gcm",
          timeout: PUSH_TIMEOUT_MS,
          urgency: "normal",
          vapidDetails: args.config,
        });
        delivered += 1;
      } catch (error) {
        if (
          error instanceof WebPushError &&
          (error.statusCode === 404 || error.statusCode === 410)
        ) {
          gone.push(subscription.id);
          return;
        }
        failed += 1;
        logWarn("notification.push.failed", {
          "error.type":
            error instanceof WebPushError
              ? `http_${error.statusCode}`
              : error instanceof Error
                ? error.name
                : "unknown",
        });
      }
    }),
  );
  await deletePushSubscriptionsById(args.db, gone);
  logInfo("notification.push.sent", {
    "app.notification.delivered": delivered,
    "app.notification.failed": failed,
    "app.notification.removed": gone.length,
  });
  return { delivered, failed, removed: gone.length };
}
