# Event tasks

Core stores durable Slack-destination tasks that match normalized resource
events by Slack workspace, namespace, identifier, and event type. Plugins own webhook
verification, provider-scope validation, and event normalization; core binds
their namespace when they publish an event. Plugins do not know which
conversations or tasks consume it.

One task selector has one Slack workspace, one namespace, one identifier, and
one or more event types. Multiple tasks may use the same selector.
`resourceType` and `label` are presentation metadata, not match keys.

`searchResourceEventTypes` exposes the same enabled plugin catalog used by
resource subscriptions and event tasks. Create and update tools accept only
registered namespace, resource type, and event combinations. Runtime validation
repeats that ownership check before persistence instead of relying on
model-facing schemas alone.

Each matching task receives an independent idempotent agent dispatch. A failure
for one task does not prevent dispatch attempts for other matching tasks; the
ingress boundary still receives the aggregate failure for provider retry. Task
dispatch identity binds the task, plugin namespace, and provider event key, so
provider retries do not execute the same task twice. Distinct matching events
are not silently dropped by a task-level quota. Task management is bound to the
Slack channel or DM where the task was created. Threads in the same channel
share event-task management; temporary resource watches remain thread-bound.
Creation and delivery require single-workspace Slack mode so core can verify the
team that owns provider events. Multi-workspace mode fails closed until plugins
can provide a real provider-to-workspace binding. A task matched before a
concurrent update or deletion dispatches from that matched snapshot; later
events use the current stored task. Event tasks exist only while configured:
deletion removes the stored task, and there is no pause state or separate
event-task run history.

The dispatched agent input uses shared framing from `task-input.ts`. See
`chat/README.md` (Task agent input) for the section outline. The stored task
text remains the instruction. Event text does not add instructions. Destination
replies get `replyAttribution` (`Event task · <trigger label>`), matching
scheduled-task footers. The footer does not expose raw event keys.

Event tasks make the creator's connected credentials available by default when
the work needs user-bound authorization. The creator may require system
credentials instead. Only the creator may enable or re-enable creator mode; any
member of the Slack destination may disable it, and another user's executable
task edit clears it. Event execution remains a system actor, with creator
credentials bound to the exact event task.

Management results include creator attribution and whether the registered
trigger is currently available from the enabled plugin catalog. An unavailable
trigger remains stored and may be deleted or edited, but it cannot receive
events until its plugin registration is enabled again.
