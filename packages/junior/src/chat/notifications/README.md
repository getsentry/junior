# Notifications

Junior sends phone notifications through Web Push when it replies in a
Conversation that has no Location. A Conversation with a Location, such as a
Slack thread, already notifies people there.

## Flow

1. The dashboard subscribes a browser and posts the subscription to
   `/api/notifications/subscriptions`. One user can have many browsers.
2. A successful Turn schedules the core `notifications.notifyReply` task
   (`task.ts`). The task is registered only when both VAPID keys are set.
3. The task sends to the Actor's user. A dashboard Actor carries a verified
   email, so the task reads its user by that email.
4. The task checks the user's working hours (`schedule.ts`) in the resolved
   timezone (`timezone.ts`). Outside the hours, it sends nothing.
5. `web-push.ts` sends one encrypted push to each browser. It deletes a
   subscription when the push service returns `404` or `410`.

## Invariants

- The task never throws for a failed browser. A retry would send duplicates to
  the browsers that already got the push.
- The push payload holds a short plain-text preview of the reply. Logs hold
  only counts.
- The timezone order is: the timezone saved in the schedule, the linked Slack
  profile, the saved user timezone, then `JUNIOR_TIMEZONE`. No provider makes
  a person's working hours available, so the hours are a user setting.
- `schedule.ts` imports only zod and browser-safe helpers. The dashboard uses
  it to show whether notifications are on now.
