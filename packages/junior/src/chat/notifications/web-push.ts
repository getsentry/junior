import webPush, { WebPushError } from "web-push";
import type { JuniorDatabase } from "@/db/db";
import { logInfo, logWarn, setSpanStatus, withSpan } from "@/chat/logging";
import {
  deletePushSubscriptionsById,
  listPushSubscriptions,
  type StoredPushSubscription,
} from "./store";

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

/** Web Push accepts only an `https:` or `mailto:` VAPID subject. */
function isVapidSubject(subject: string): boolean {
  return /^(https:\/\/|mailto:)/.test(subject);
}

/**
 * Read VAPID settings from the environment. Phone notifications are off when
 * either key is missing or the subject is not `https:` or `mailto:`, such as
 * an `http://` base URL.
 */
export function readWebPushConfig(): WebPushConfig | undefined {
  const publicKey = process.env.JUNIOR_WEB_PUSH_PUBLIC_KEY?.trim();
  const privateKey = process.env.JUNIOR_WEB_PUSH_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return undefined;
  const subject =
    process.env.JUNIOR_WEB_PUSH_SUBJECT?.trim() || subjectFromBaseUrl();
  if (!subject || !isVapidSubject(subject)) return undefined;
  return { privateKey, publicKey, subject };
}

/** What caused a notification. A test send comes from the settings page. */
export type PushNotificationKind = "reply" | "test";

/** Device counts for one notification sent to one user. */
export interface PushNotificationResult {
  delivered: number;
  devices: number;
  failed: number;
  removed: number;
}

type PushOutcome = "delivered" | "failed" | "gone";

function pushErrorType(error: unknown): string {
  if (error instanceof WebPushError) return `http_${error.statusCode}`;
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Send one notification to one browser in a `notification.push.send` span.
 * The span records only the push service host: the endpoint path identifies
 * the device.
 */
async function sendToDevice(
  subscription: StoredPushSubscription,
  body: string,
  config: WebPushConfig,
): Promise<PushOutcome> {
  const serverAddress = new URL(subscription.endpoint).hostname;
  return await withSpan(
    "notification.push.send",
    "notification.push.send",
    {},
    async (setSpanAttributes) => {
      let outcome: PushOutcome;
      let statusCode: number | undefined;
      try {
        ({ statusCode } = await webPush.sendNotification(subscription, body, {
          TTL: PUSH_TTL_SECONDS,
          contentEncoding: "aes128gcm",
          timeout: PUSH_TIMEOUT_MS,
          urgency: "normal",
          vapidDetails: config,
        }));
        outcome = "delivered";
      } catch (error) {
        statusCode =
          error instanceof WebPushError ? error.statusCode : undefined;
        outcome = statusCode === 404 || statusCode === 410 ? "gone" : "failed";
        if (outcome === "failed") {
          setSpanStatus("error");
          logWarn("notification.push.failed", {
            "error.type": pushErrorType(error),
            "server.address": serverAddress,
          });
        }
      }
      setSpanAttributes({ "app.notification.push.outcome": outcome });
      if (statusCode) {
        setSpanAttributes({ "http.response.status_code": statusCode });
      }
      return outcome;
    },
    { "server.address": serverAddress },
  );
}

/**
 * Send one notification to every browser of one user. A failed browser does
 * not stop the others or fail the call. Subscriptions that the push service
 * reports as gone are deleted. When a queued task retries after a send, the
 * payload tag replaces the earlier notification on the device.
 */
export async function sendPushNotificationToUser(args: {
  config: WebPushConfig;
  db: JuniorDatabase;
  kind: PushNotificationKind;
  payload: PushNotificationPayload;
  userId: string;
}): Promise<PushNotificationResult> {
  const subscriptions = await listPushSubscriptions(args.db, args.userId);
  const body = JSON.stringify(args.payload);
  const outcomes = await Promise.all(
    subscriptions.map((subscription) =>
      sendToDevice(subscription, body, args.config),
    ),
  );
  const gone = subscriptions
    .filter((_, index) => outcomes[index] === "gone")
    .map((subscription) => subscription.id);
  await deletePushSubscriptionsById(args.db, gone);
  const result: PushNotificationResult = {
    delivered: outcomes.filter((outcome) => outcome === "delivered").length,
    devices: subscriptions.length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    removed: gone.length,
  };
  logInfo("notification.push.sent", {
    "app.notification.kind": args.kind,
    "app.notification.devices": result.devices,
    "app.notification.delivered": result.delivered,
    "app.notification.failed": result.failed,
    "app.notification.removed": result.removed,
  });
  return result;
}
