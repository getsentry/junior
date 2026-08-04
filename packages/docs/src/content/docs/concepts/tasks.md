---
title: Tasks
description: Create, inspect, and operate Junior's scheduled and resource-event tasks.
type: conceptual
summary: Understand how Junior runs durable work on a schedule or after a registered resource event.
prerequisites:
  - /start-here/quickstart/
  - /start-here/slack-app-setup/
related:
  - /operate/dashboard/
  - /concepts/credentials-and-oauth/
  - /operate/reliability-runbooks/
---

Tasks are durable instructions that Junior runs later. Task support is part of `@sentry/junior`; no Scheduler plugin or separate package is required.

Junior supports two task kinds:

| Kind      | Trigger                                                | Example                                      |
| --------- | ------------------------------------------------------ | -------------------------------------------- |
| Scheduled | A one-time or recurring schedule                       | “Every Monday at 9 AM, post a project recap” |
| Event     | A matching event from an enabled resource-event plugin | “When this issue closes, summarize it here”  |

Both kinds preserve their Slack destination and run through Junior's durable conversation work path. Signed-in users can inspect and delete their own tasks from the dashboard's **Tasks** page.

## Create and manage scheduled tasks

Ask Junior in the Slack conversation where the result should be delivered:

```text
remind me in 10 minutes to stretch
```

Junior can also list, update, delete, or run a scheduled task immediately:

```text
what scheduled tasks do I have?
move my weekly recap to Friday at 3 PM
run the weekly recap now
```

Simple one-time reminders can be created immediately. Recurring work and tasks that may use connected credentials require action review.

## Create event tasks

Event tasks require an enabled plugin that publishes the requested resource type and event. For example, an issue plugin may allow:

```text
when ACME-42 closes, summarize the resolution in this channel
```

If the contributing plugin is later disabled, the task remains visible in the Tasks page but its trigger is shown as unavailable. Re-enable a compatible plugin or delete the task.

## Configure heartbeat delivery

`juniorNitro()` emits the internal heartbeat route into Nitro's Vercel Build Output config. If you deploy outside Vercel, call the route every minute:

| Route                     | Purpose                                               |
| ------------------------- | ----------------------------------------------------- |
| `/api/internal/heartbeat` | Claims due scheduled work and runs plugin heartbeats. |

Set one production heartbeat secret:

| Variable                                   | Purpose                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `CRON_SECRET` or `JUNIOR_SCHEDULER_SECRET` | Bearer token for the internal heartbeat route. Use `CRON_SECRET` with Vercel Cron. |
| `JUNIOR_TIMEZONE`                          | Default IANA timezone for schedule authoring. Defaults to `America/Los_Angeles`.   |

## Verify

1. Ask Junior to remind you in one minute.
2. Open the dashboard's **Tasks** page and confirm the scheduled task appears.
3. Wait for the reminder to post in the original Slack conversation.
4. If a resource-event plugin is enabled, create an event task and confirm it appears beside the scheduled task.

If due work does not run, confirm the heartbeat route is called every minute and its bearer token matches the configured secret. Then inspect conversation work logs for mailbox, lease, or delivery failures.

## Next step

Use [Dashboard](/operate/dashboard/) to configure the authenticated Tasks view, then review [Credentials & OAuth](/concepts/credentials-and-oauth/) before creating tasks that use connected accounts.
