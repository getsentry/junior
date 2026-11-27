Fixes the flaky "shows a push notification that has no tag" e2e test. Both copies are affected: classic `e2e/settings.spec.ts` and inbox `e2e/inbox/settings.spec.ts`.

The test failed at the final `expect.poll(... getNotifications() ...).toEqual(["Junior"])` and saw `Received: []` for all 10s. The retry passed. Failed runs:
- https://github.com/getsentry/junior/actions/runs/45070158782/job/137357691017 (main, classic)
- https://github.com/getsentry/junior/actions/runs/45064839548/job/137339296442 (main, inbox)
- https://github.com/getsentry/junior/actions/runs/45068625838/job/137350582090 (getsentry/junior#3797, classic)

**Root cause.** Chrome races when it shows a persistent notification and reads them at the same time. `showNotification()` writes the notification to Chrome's notification database first, then displays it. A `getNotifications()` call deletes every stored notification that the platform does not list as displayed, unless it was created after the read started. A read that starts after the write but before the display deletes the new notification. After that, every later read returns `[]`, even though the notification is on screen. The test began to poll `getNotifications()` right after `deliverPushMessage`, so its first poll sometimes ran while the worker's `showNotification()` was still in progress. The CI traces match this: the push reached the activated registration, and every poll returned `[]`.

You can reproduce this without the worker: call `registration.showNotification("Probe")` and `registration.getNotifications()` together from the page. A later `getNotifications()` then returns `[]` in 9 of 10 runs. With the two calls in sequence, it returns `["Probe"]` in 10 of 10.

The worker is not affected. Its badge read starts after `showNotification()` resolves, which is after the display.

**Change.**
- Add `e2e/push-notification.ts` with `showPlainTextPush(page)`, which both tests now use. It records the DevTools BackgroundService `notifications` events and delivers the same plain text push as before. It then waits for Chrome's "Notification displayed" event and reads `getNotifications()` once. Chrome sends that event after the database write and the display, so the read cannot overlap the show.
- Lower the `dashboard-spec-page-script` baseline for both spec files, because the page script moved into the helper.
- Add the helper to the dashboard type-check project.
