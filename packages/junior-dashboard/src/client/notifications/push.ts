/**
 * Browser side of phone notifications: service worker registration and the
 * Web Push subscription for this device.
 */
import { DASHBOARD_SERVICE_WORKER_PATH } from "../../service-worker";

/** What this browser can do with phone notifications. */
export type PushSupport =
  | "supported"
  /** iPhone and iPad allow Web Push only from a Home Screen app. */
  | "needs-install"
  | "unsupported";

/** Match the manifest scope, so the worker covers every dashboard page. */
function dashboardScope(): string {
  return window.__JUNIOR_DASHBOARD_BASE_PATH__ ?? "/";
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isAppleMobile(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** Report whether this browser can receive phone notifications now. */
export function pushSupport(): PushSupport {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    return isAppleMobile() && !isStandalone() ? "needs-install" : "unsupported";
  }
  if (!("PushManager" in window) || !("Notification" in window)) {
    return isAppleMobile() && !isStandalone() ? "needs-install" : "unsupported";
  }
  return "supported";
}

let registration: Promise<ServiceWorkerRegistration> | undefined;

/** Register the dashboard service worker once per page load. */
export function registerDashboardServiceWorker():
  | Promise<ServiceWorkerRegistration>
  | undefined {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    return undefined;
  }
  registration ??= navigator.serviceWorker.register(
    DASHBOARD_SERVICE_WORKER_PATH,
    { scope: dashboardScope() },
  );
  return registration;
}

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = `${publicKey}${"=".repeat((4 - (publicKey.length % 4)) % 4)}`;
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function sameKey(
  subscription: PushSubscription,
  key: Uint8Array<ArrayBuffer>,
): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return (
    bytes.length === key.length &&
    bytes.every((value, index) => value === key[index])
  );
}

/** Return this device's current subscription without registering a worker. */
export async function currentPushSubscription(): Promise<
  PushSubscription | undefined
> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    return undefined;
  }
  const existing =
    await navigator.serviceWorker.getRegistration(dashboardScope());
  return (await existing?.pushManager.getSubscription()) ?? undefined;
}

/**
 * Ask for permission and subscribe this device. A subscription made with an
 * older server key is replaced.
 */
export async function subscribeThisDevice(
  publicKey: string,
): Promise<PushSubscriptionJSON> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }
  const ready = registerDashboardServiceWorker();
  if (!ready) throw new Error("Service workers are not available.");
  const { pushManager } = await ready;
  const key = applicationServerKey(publicKey);
  const existing = await pushManager.getSubscription();
  if (existing && sameKey(existing, key)) return existing.toJSON();
  await existing?.unsubscribe();
  const subscription = await pushManager.subscribe({
    applicationServerKey: key,
    userVisibleOnly: true,
  });
  return subscription.toJSON();
}

/** Unsubscribe this device and return its endpoint. */
export async function unsubscribeThisDevice(): Promise<string | undefined> {
  const subscription = await currentPushSubscription();
  if (!subscription) return undefined;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  return endpoint;
}

/** Clear the Home Screen badge after the user opens the app. */
export function clearAppBadge(): void {
  const badgeNavigator = navigator as Navigator & {
    clearAppBadge?: () => Promise<void>;
  };
  void badgeNavigator.clearAppBadge?.().catch(() => undefined);
}
