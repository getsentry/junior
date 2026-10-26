---
title: Automations
description: Run Junior later on a schedule or after an Event.
type: conceptual
summary: Understand scheduled and event automations, their destinations, and their access.
prerequisites:
  - /start-here/using-junior/
related:
  - /concepts/watches/
  - /concepts/credentials-and-oauth/
  - /operate/dashboard/
---

Automations are saved instructions that Junior runs later. They are built into `@sentry/junior`.

## Automation Types

| Type                 | Trigger                      | Example                                     |
| -------------------- | ---------------------------- | ------------------------------------------- |
| Scheduled automation | A date or recurring schedule | “Every Monday at 9am, post a project recap” |
| Event automation     | An Event from a plugin       | “When this issue closes, summarize it here” |

A watch is different: it follows one resource temporarily without storing an instruction. See [Watches](/concepts/watches/).

## Scheduled Automations

Ask in the Slack conversation where results should appear:

```text
remind me in 10 minutes to stretch
every Monday at 9am, post a project recap in this channel
```

Junior can list, update, delete, or run a scheduled automation immediately:

```text
what scheduled automations do I have?
move my weekly recap to Friday at 3pm
run the weekly recap now
move my weekly planning reminder from #ops here
```

Ask in the destination conversation when rehoming a automation across channels. Junior lists the requester's matching automation and updates that existing schedule to deliver here; it does not require opening the source channel first.

## Event Automations

Event automations run when a plugin publishes the selected resource and event, or when someone posts a new message in a Slack channel:

```text
when ACME-42 closes, summarize the resolution in this channel
whenever a new issue is created in Linear team SRE, investigate it and comment findings on the issue
when someone posts a new message in this channel, answer it if you can, otherwise tag me
```

A Slack channel-message automation runs for each new top-level message in the channel where you create it. It does not run for thread replies or for messages that mention Junior. It runs for a bot message, such as a Sentry alert, only when the automation names that bot's Slack user ID in `match.userId`. Junior replies in the thread of the message. Junior must be a member of the channel. The automation can watch only its own channel, and it always runs with Junior's own credentials, because anyone in the channel can write the message. Tell the channel that Junior reads every new message there.

If the plugin is disabled, the automation remains visible but cannot receive events until a compatible plugin is enabled again. Each plugin page lists the resources and events it can publish.

Each event automation can start at most 10 runs in a minute. Set `limits.maxEventAutomationRunsPerMinute` in `createApp()` to change this number. The limit applies to that one automation, so other automations on the same trigger keep running. When an automation reaches the limit, Junior blocks it and sends its creator a direct message. Resume the automation after you narrow its trigger.

## Access and Delivery

- Automations run as Junior and deliver to the Slack channel or DM currently set as the automation destination.
- New automations start in the conversation where they were created; creators can later update their own automation so it delivers in another conversation they are currently talking in.
- A automation may use its creator's connected account when access was delegated to that automation.
- Only the creator can enable creator credential access or change a automation's destination.
- Event content is treated as data, not as a user instruction.
- Action review still applies when required.

Signed-in users can inspect and delete their automations from the dashboard **Automations** page. Completed one-off reminders stay under **Mine** so creators can confirm they ran.

## Verify Automations

1. Ask Junior to remind you in one minute.
2. Confirm the automation appears on the dashboard **Automations** page.
3. Confirm the reminder arrives in the original Slack conversation.

If automations do not run, follow [Reliability Runbooks](/operate/reliability-runbooks/) to check the heartbeat and conversation worker.

## Next Step

Read [Credentials & OAuth](/concepts/credentials-and-oauth/) before using connected accounts in scheduled or event automations.
