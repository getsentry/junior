/** Public path of the dashboard service worker script. */
export const DASHBOARD_SERVICE_WORKER_PATH = "/_junior/dashboard/sw.js";

/**
 * The service worker only shows phone notifications. It has no `fetch`
 * handler, so it never caches or changes dashboard requests.
 *
 * Every push shows a notification. Safari and Chrome penalize a push that
 * shows nothing. When the user already looks at the same page, the
 * notification is silent.
 */
const SERVICE_WORKER_SOURCE = String.raw`
const SCOPE_URL = new URL(self.registration.scope);

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
      const windows = await self.clients.matchAll({
        includeUncontrolled: true,
        type: "window",
      });
      const existing = windows.find((client) =>
        client.url.startsWith(SCOPE_URL.href),
      );
      if (existing) {
        await existing.focus();
        if (existing.url !== url.href && "navigate" in existing) {
          await existing.navigate(url.href).catch(() => undefined);
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
