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

| Type           | Trigger                        | Example                                     |
| -------------- | ------------------------------ | ------------------------------------------- |
| Scheduled task | A date or recurring schedule   | “Every Monday at 9am, post a project recap” |
| Event task     | A resource event from a plugin | “When this issue closes, summarize it here” |

A resource subscription is different: it follows one resource temporarily without storing an instruction. See [Resource Subscriptions](/concepts/resource-subscriptions/).

## Scheduled Tasks

Ask in the Slack conversation where results should appear:

```text
remind me in 10 minutes to stretch
every Monday at 9am, post a project recap in this channel
```

Junior can list, update, delete, or run a scheduled task immediately:

```text
what scheduled tasks do I have?
move my weekly recap to Friday at 3pm
run the weekly recap now
move my weekly planning reminder from #ops here
```

Ask in the destination conversation when rehoming a task across channels. Junior lists the requester's matching task and updates that existing schedule to deliver here; it does not require opening the source channel first.

## Event Tasks

Event tasks require a plugin that publishes the selected resource and event:

```text
when ACME-42 closes, summarize the resolution in this channel
whenever a new issue is created in Linear team SRE, investigate it and comment findings on the issue
```

If the plugin is disabled, the task remains visible but cannot receive events until a compatible plugin is enabled again. Each plugin page lists the resources and events it can publish.

## Access and Delivery

- Tasks run as Junior and deliver to the Slack channel or DM currently set as the task destination.
- New tasks start in the conversation where they were created; creators can later update their own task so it delivers in another conversation they are currently talking in.
- A task may use its creator's connected account when access was delegated to that task.
- Only the creator can enable creator credential access or change a task's destination.
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
