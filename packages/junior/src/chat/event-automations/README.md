# Event automations

Core stores event automations that match normalized events by Slack workspace,
namespace, identifier, and event type. Plugins verify webhooks, validate provider
scope, and normalize events. Core binds the plugin namespace when it publishes
an event. Plugins do not know which conversations or automations consume it.

Slack channel messages are the one core event source for automations
(`slack/channel-message-events.ts`). Slack ingress publishes `slack` /
`channel` / `message.posted` for a new top-level message from a workspace member
when no other route handles it. Thread replies, mentions, subscribed threads,
bots, and Junior's own messages do not publish. The event goes to event
automations only; a Watch cannot select it. An automation can watch only the
channel where it posts. The trigger identifier `current_channel` names that
channel, and create and edit reject another channel. This keeps private channel
text out of other channels. Runs always use system credentials, because anyone
in the channel writes the Event text. Each run replies in the thread of the
source message. Junior must be a member of the channel to receive the messages.

One selector has one Slack workspace, namespace, identifier, and one or more
event types. Multiple automations can use the same selector.
`resourceType` and `label` are presentation metadata, not match keys.

`searchEventTypes` exposes the same enabled plugin catalog used by
watches and event automations. Create and update tools accept only
registered namespace, resource type, and event combinations. Runtime validation
repeats that ownership check before persistence instead of relying on
model-facing schemas alone.

Each matching automation receives an independent idempotent agent dispatch. A
failure for one automation does not stop other matching automations. The ingress
boundary receives the combined failure so the provider can retry. Dispatch
identity binds the automation, plugin namespace, and provider event key. A
provider retry does not run the same automation twice. Dispatches do not use the
consecutive automated-turn limit. Each dispatch runs in its own Conversation, and
the limit is not counted for a Destination. A shared Destination count paused
unrelated automations in the same channel.

Event automations target channels or DMs, not threads. A run for a Slack
channel message is the exception at dispatch time: its Destination adds the
source message as the thread. The stored Destination stays the channel. Migration 0044 removes
stored thread destinations. Reads also remove thread fields written by older
workers during deployment; new writes reject them.

Listing stays bound to the destination where the automation was created. Threads
in that destination share the list. Update and delete also accept a public
automation by id from another destination in the same workspace. Private
automations stay local to their destination. Watches remain thread-bound.
Creation and delivery require single-workspace Slack mode so core can verify the
team that owns provider events. Multi-workspace mode fails closed until plugins
can provide a real provider-to-workspace binding.

An Automation matched before a concurrent edit, pause, or deletion may still run.
Paused rows do not match new events. Resume does not replay events received during
the pause. Provider retries still use the event key to prevent duplicate runs.
Deletion keeps the row and execution history.

Deploy all workers before using pause. Older workers still match paused rows.

Each Event automation can start at most
`botConfig.maxEventAutomationRunsPerHour` runs in a rolling hour
(`run-limit.ts`). The default is 10. A host sets it with
`createApp({ limits: { maxEventAutomationRunsPerHour } })`. The one-hour
window is fixed. The limit applies to one Automation, not to its trigger or
namespace. Another Automation on the same trigger keeps its own count. Event
automations do not use the consecutive automated-turn limit, so this limit is
what stops a noisy trigger from starting a full agent Turn for every Event.
Ingest counts a run before dispatch. Each run appends one entry with its
dispatch idempotency key to a short list in the state adapter. Then it counts
the keys from the last hour up to the first entry with its own key. The append
is atomic, so the list order decides which runs fit when Events arrive at the
same moment. No lock is needed. A provider retry has the same key, so it gets
the same answer and does not count again. When the hour is full, ingest skips the dispatch and blocks
the Automation with a reason, and its creator gets the blocked notice. Each
block also captures one Sentry issue event with the fingerprint
`event_automation.run_limit.blocked` and the `app.task.id` of the Automation.
Events refused after the block do not capture again. Resume appends a reset
entry, so runs before it do not count and the next Event runs at once. Recreating a deleted automation also
clears it. Both clear the count before the row becomes active.

A blocked dispatch blocks its Automation: a run could not get the authorization
or credentials that it needs, and only the creator can fix that. A blocked row
keeps the reason in `status_reason` and does not match new events. Resume
clears the reason and makes the row active. A row that was paused when its run
blocked stays paused and keeps the reason, so resume returns it to blocked.
The dashboard and the automation tools show the status and the reason. Only
the creator can pause or resume, from the Automation settings or from chat.

When a Scheduled automation or an Event automation first becomes blocked, its
creator gets one direct message with the reason and a resume link
(`automations/blocked-notice.ts`). The notice goes only after the Automation is
stored as blocked: at dispatch block for an Event automation, and at heartbeat
reconcile for a Scheduled automation. The notice is best-effort. A failed send
logs `automation.blocked_notice.failed`.

The dispatched agent input uses shared framing from `task-input.ts`. See
`chat/README.md` for the input format. The stored automation text remains the
instruction. Event text does not add instructions. Destination
replies get `replyAttribution` (`Event automation · <trigger label>`), matching
scheduled-automation footers. The footer does not expose raw event keys.

Event automations make the creator's connected credentials available by default when
the work needs user-bound authorization. The creator may require system
credentials instead. Only the creator may enable or re-enable creator mode; any
member of the Slack destination may disable it. An executable edit by another
user clears it. Event execution remains a system actor, with creator
credentials bound to the exact event automation.

Management results include creator attribution and whether the registered
trigger is currently available from the enabled plugin catalog. An unavailable
trigger remains stored and may be deleted or edited, but it cannot receive
events until its plugin registration is enabled again.
