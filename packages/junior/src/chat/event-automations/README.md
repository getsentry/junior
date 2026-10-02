# Event automations

Core stores event automations that match normalized events by Slack workspace,
namespace, identifier, and event type. Plugins verify webhooks, validate provider
scope, and normalize events. Core binds the plugin namespace when it publishes
an event. Plugins do not know which conversations or automations consume it.

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

Event automations target channels or DMs, not threads. Migration 0044 removes
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
