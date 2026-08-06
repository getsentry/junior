---
title: Tasks
description: Run Junior later on a schedule or after a resource event.
type: conceptual
summary: Create durable scheduled and event tasks without confusing them with live thread work.
prerequisites:
  - /start-here/using-junior/
related:
  - /concepts/resource-subscriptions/
  - /concepts/credentials-and-oauth/
  - /operate/dashboard/
---

Tasks are durable instructions Junior runs later. They are built into `@sentry/junior`. You do not need a separate scheduler package.

## Work now vs later

| Kind | When it runs | Stores an instruction? |
| ---- | ------------ | ---------------------- |
| Current turn | Right now in the thread | No |
| Resource subscription | When a watched event arrives | No |
| Scheduled task | On a one-time or recurring schedule | Yes |
| Event task | When a matching plugin event arrives | Yes |

Ask in the Slack conversation where the result should land.

## Scheduled tasks

```text
remind me in 10 minutes to stretch
every Monday at 9am, post a project recap in this channel
```

Junior can also list, update, delete, or run one immediately:

```text
what scheduled tasks do I have?
move my weekly recap to Friday at 3pm
run the weekly recap now
```

## Event tasks

Event tasks need an enabled plugin that publishes the resource and event:

```text
when ACME-42 closes, summarize the resolution in this channel
whenever an issue is reopened in this repository, summarize why here
```

If the plugin later goes away, the task can remain visible with an unavailable trigger. Re-enable a compatible plugin or delete the task.

## Authority

This part matters:

- task runs use a system actor
- the stored Slack destination controls where results go
- creator credentials may be available for that exact task when the work needs them
- attribution is not authority; creating a task does not make every later run “act as you” in general
- event payloads are input data, not a new user identity
- any member of the destination can usually manage the task; only the creator can turn creator credentials back on

Action review may still apply when a task is created or changed. That is automatic policy enforcement. It does not always mean Junior will ping you for a second confirmation.

## Operate it

Signed-in users can inspect and delete their own tasks from the dashboard **Tasks** page.

For non-Vercel hosts, call the heartbeat every minute:

| Route | Purpose |
| ----- | ------- |
| `/api/internal/heartbeat` | Claims due scheduled work and runs plugin heartbeats |

| Variable | Purpose |
| -------- | ------- |
| `CRON_SECRET` or `JUNIOR_SCHEDULER_SECRET` | Bearer token for the heartbeat route |
| `JUNIOR_TIMEZONE` | Default timezone for schedule authoring |

## Verify

1. Ask Junior to remind you in one minute.
2. Confirm the task appears on the dashboard **Tasks** page.
3. Wait for the reminder in the original Slack conversation.
4. If a resource-event plugin is enabled, create one event task and confirm it appears too.

If due work never runs, confirm the heartbeat route is called every minute with the right secret, then check conversation work logs.

## Next step

Use [Resource Subscriptions](/concepts/resource-subscriptions/) for temporary watches, and [Credentials & OAuth](/concepts/credentials-and-oauth/) before relying on connected accounts in later runs.
