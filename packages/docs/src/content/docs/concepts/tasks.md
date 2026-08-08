---
title: Tasks
description: Run Junior later on a schedule or after a resource event.
type: conceptual
summary: Understand scheduled and event tasks, their destinations, and their access.
prerequisites:
  - /start-here/using-junior/
related:
  - /concepts/resource-subscriptions/
  - /concepts/credentials-and-oauth/
  - /operate/dashboard/
---

Tasks are saved instructions that Junior runs later. They are built into `@sentry/junior`.

## Task Types

| Type | Trigger | Example |
| ---- | ------- | ------- |
| Scheduled task | A date or recurring schedule | “Every Monday at 9am, post a project recap” |
| Event task | A resource event from a plugin | “When this issue closes, summarize it here” |

A resource subscription is different: it follows one resource temporarily without storing an instruction. See [Resource Subscriptions](/concepts/resource-subscriptions/).

## Scheduled Tasks

Ask in the Slack conversation where results should appear:

```text
remind me in 10 minutes to stretch
every Monday at 9am, post a project recap in this channel
```

Junior can list, update, delete, run, or move a scheduled task immediately:

```text
what scheduled tasks do I have?
move my weekly recap to Friday at 3pm
run the weekly recap now
move my weekly planning reminder from #ops here
```

Ask in the destination conversation when moving a task across channels. Junior finds the requester's matching task and rehomes that existing schedule; it does not require listing the source channel first.

## Event Tasks

Event tasks require a plugin that publishes the selected resource and event:

```text
when ACME-42 closes, summarize the resolution in this channel
```

If the plugin is disabled, the task remains visible but cannot receive events until a compatible plugin is enabled again.

## Access and Delivery

- Tasks run as Junior and deliver to the Slack channel or DM currently set as the task destination.
- New tasks start in the conversation where they were created; creators can later move their own task into another conversation they are currently talking in.
- A task may use its creator's connected account when access was delegated to that task.
- Only the creator can enable creator credential access or move a task.
- Event content is treated as data, not as a user instruction.
- Action review still applies when required.

Signed-in users can inspect and delete their tasks from the dashboard **Tasks** page. Completed one-off reminders stay under **Mine** so creators can confirm they ran.

## Verify Tasks

1. Ask Junior to remind you in one minute.
2. Confirm the task appears on the dashboard **Tasks** page.
3. Confirm the reminder arrives in the original Slack conversation.

If tasks do not run, follow [Reliability Runbooks](/operate/reliability-runbooks/) to check the heartbeat and conversation worker.

## Next Step

Read [Credentials & OAuth](/concepts/credentials-and-oauth/) before using connected accounts in scheduled or event tasks.
