import { expect, type Page } from "@playwright/test";

import { DASHBOARD_SERVICE_WORKER_PATH } from "../src/service-worker";

/**
 * Send the plain text push that the DevTools Push button sends to the
 * dashboard service worker. Return the titles of the worker's notifications
 * after Chrome displays the new one.
 */
export async function showPlainTextPush(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  const registrationId = new Promise<string>((resolve) => {
    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      const active = versions.find((version) => version.status === "activated");
      if (active) resolve(active.registrationId);
    });
  });
  // Chrome stores a notification before it displays it. A getNotifications()
  // call in that gap deletes the stored notification, so read only after
  // Chrome reports the display.
  let displayed = false;
  cdp.on(
    "BackgroundService.backgroundServiceEventReceived",
    ({ backgroundServiceEvent }) => {
      if (backgroundServiceEvent.eventName === "Notification displayed") {
        displayed = true;
      }
    },
  );
  await cdp.send("BackgroundService.startObserving", {
    service: "notifications",
  });
  await cdp.send("BackgroundService.setRecording", {
    service: "notifications",
    shouldRecord: true,
  });
  await cdp.send("ServiceWorker.enable");
  await page.evaluate(async (path) => {
    await navigator.serviceWorker.register(path, { scope: "/" });
    await navigator.serviceWorker.ready;
  }, DASHBOARD_SERVICE_WORKER_PATH);

  await cdp.send("ServiceWorker.deliverPushMessage", {
    data: "Test push message from DevTools.",
    origin: new URL(page.url()).origin,
    registrationId: await registrationId,
  });
  await expect.poll(() => displayed).toBe(true);
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.getNotifications()).map(
      (notification) => notification.title,
    );
  });
}
