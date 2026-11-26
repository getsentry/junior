import { getChatConfig } from "@/chat/config";
import { mapBounded } from "@/chat/fan-out";
import { listClearedInboxItemPushes } from "@/chat/inbox-items/deliveries";
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
  /**
   * Tags of earlier notifications that the device closes first, such as
   * pushes of Inbox items that closed since. Web Push cannot close a
   * notification without showing one, so the next push carries them.
   */
  close?: string[];
  /** Replaces an older notification with the same tag on the device. */
  tag: string;
  title: string;
  /** Dashboard URL to open when the user taps the notification. */
  url: string;
}

/** Keep a notification for 12 hours while the device is offline. */
const PUSH_TTL_SECONDS = 12 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;

function subjectFromBaseUrl(): string | undefined {
  const { baseUrl } = getChatConfig().deployment;
  if (!baseUrl) return undefined;
  return baseUrl.startsWith("https://") || baseUrl.startsWith("http://")
    ? baseUrl
    : `https://${baseUrl}`;
}

/** Web Push accepts only an `https:` or `mailto:` VAPID subject. */
function isVapidSubject(subject: string): boolean {
  return subject.startsWith("https://") || subject.startsWith("mailto:");
}

/**
 * Read VAPID settings from config. Push notifications are off when
 * either key is missing or the subject is not `https:` or `mailto:`, such as
 * an `http://` base URL.
 */
export function readWebPushConfig(): WebPushConfig | undefined {
  const {
    privateKey,
    publicKey,
    subject: configuredSubject,
  } = getChatConfig().webPush;
  if (!publicKey || !privateKey) return undefined;
  const subject = configuredSubject || subjectFromBaseUrl();
  if (!subject || !isVapidSubject(subject)) return undefined;
  return { privateKey, publicKey, subject };
}

/** What caused a notification. A test send comes from the settings page. */
export type PushNotificationKind = "inbox_item" | "reply" | "test" | "wake";

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
  const close = await listClearedInboxItemPushes(
    args.db,
    args.userId,
    Date.now() - PUSH_TTL_SECONDS * 1000,
  );
  const body = JSON.stringify(
    close.length > 0 ? { ...args.payload, close } : args.payload,
  );
  const outcomes = await mapBounded(subscriptions, (subscription) =>
    sendToDevice(subscription, body, args.config),
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
