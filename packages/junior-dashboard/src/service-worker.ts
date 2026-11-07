/** Public path of the dashboard service worker script. */
export const DASHBOARD_SERVICE_WORKER_PATH = "/_junior/dashboard/sw.js";

/**
 * Cache Storage entry that holds the URL of the last tapped notification.
 * The key is a cache key only; no route serves it.
 */
export const NOTIFICATION_TARGET_CACHE = "junior-notification-target";
export const NOTIFICATION_TARGET_KEY = "/_junior/dashboard/notification-target";

/**
 * The service worker only shows phone notifications. It has no `fetch`
 * handler, so it never caches or changes dashboard requests. Its one cache
 * entry holds the last tapped notification URL for the page to open.
 *
 * Every push shows a notification. Safari and Chrome penalize a push that
 * shows nothing. When the user already looks at the same page, the
 * notification is silent.
 */
const SERVICE_WORKER_SOURCE = String.raw`
const SCOPE_URL = new URL(self.registration.scope);
const TARGET_CACHE = ${JSON.stringify(NOTIFICATION_TARGET_CACHE)};
const TARGET_KEY = new URL(${JSON.stringify(NOTIFICATION_TARGET_KEY)}, SCOPE_URL).href;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(event) {
  try {
    const data = event.data ? event.data.json() : {};
    return data && typeof data === "object" ? data : {};
  } catch (_error) {
    return {};
  }
}

function targetUrl(value) {
  try {
    const url = new URL(typeof value === "string" ? value : SCOPE_URL.href, SCOPE_URL);
    return url.origin === SCOPE_URL.origin ? url : SCOPE_URL;
  } catch (_error) {
    return SCOPE_URL;
  }
}

async function updateBadge() {
  if (!self.navigator.setAppBadge) return;
  const shown = await self.registration.getNotifications();
  if (shown.length > 0) {
    await self.navigator.setAppBadge(shown.length);
  } else if (self.navigator.clearAppBadge) {
    await self.navigator.clearAppBadge();
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const payload = readPayload(event);
      const url = targetUrl(payload.url);
      const windows = await self.clients.matchAll({
        includeUncontrolled: true,
        type: "window",
      });
      const viewing = windows.some(
        (client) =>
          client.focused &&
          client.visibilityState === "visible" &&
          new URL(client.url).pathname === url.pathname,
      );
      await self.registration.showNotification(
        typeof payload.title === "string" ? payload.title : "Junior",
        {
          body: typeof payload.body === "string" ? payload.body : "",
          data: { url: url.href },
          icon: "/_junior/dashboard/icon-512.png",
          renotify: !viewing,
          silent: viewing,
          tag: typeof payload.tag === "string" ? payload.tag : undefined,
        },
      );
      await updateBadge();
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = targetUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      // iOS can run this handler while a backgrounded Home Screen app is
      // still suspended, for example behind the lock screen. navigate() and
      // postMessage() can then get lost, and the app resumes on its old page.
      // The page reads this entry when it becomes visible and opens the URL.
      // A Cache Storage failure must not stop the navigation below.
      try {
        const cache = await caches.open(TARGET_CACHE);
        await cache.put(
          TARGET_KEY,
          new Response(JSON.stringify({ atMs: Date.now(), url: url.href }), {
            headers: { "content-type": "application/json" },
          }),
        );
      } catch (_error) {}
      const windows = await self.clients.matchAll({
        includeUncontrolled: true,
        type: "window",
      });
      const existing = windows.find((client) =>
        client.url.startsWith(SCOPE_URL.href),
      );
      if (existing) {
        await existing.focus();
        if (existing.url !== url.href) {
          // navigate() fails for a window that this worker does not control,
          // and Safari can lack it. The page then opens the URL itself.
          const navigated =
            "navigate" in existing
              ? await existing.navigate(url.href).catch(() => null)
              : null;
          if (!navigated) {
            existing.postMessage({ type: "junior:open", url: url.href });
          }
        }
      } else {
        await self.clients.openWindow(url.href);
      }
      await updateBadge();
    })(),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  const previous = event.oldSubscription;
  const options = previous && previous.options;
  if (!options || !options.applicationServerKey) return;
  event.waitUntil(
    (async () => {
      const next = await self.registration.pushManager.subscribe({
        applicationServerKey: options.applicationServerKey,
        userVisibleOnly: true,
      });
      await fetch("/api/notifications/subscriptions", {
        body: JSON.stringify(next.toJSON()),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    })(),
  );
});
`;

/**
 * Serve the service worker. `Service-Worker-Allowed` lets a script under
 * `/_junior/dashboard/` control the whole dashboard base path.
 */
export function renderServiceWorker(basePath: string): Response {
  return new Response(SERVICE_WORKER_SOURCE, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "application/javascript; charset=utf-8",
      "service-worker-allowed": basePath,
      "x-content-type-options": "nosniff",
    },
  });
}
