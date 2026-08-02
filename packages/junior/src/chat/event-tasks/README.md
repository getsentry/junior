# Event tasks

Core stores durable Slack-destination tasks that match normalized resource
events by namespace, identifier, and event type. Plugins own webhook
verification and event normalization; core binds their namespace when they
publish an event. Plugins do not know which conversations or tasks consume it.

One task selector has one namespace, one identifier, and one or more event
types. Multiple tasks may use the same selector. `resourceType` and `label` are
presentation metadata, not match keys.

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
One Junior deployment serves one Slack workspace, which is the event-task
authorization boundary. Resource events are deployment-scoped for the same
reason. Supporting multiple Slack workspaces in one deployment would require a
workspace or installation identity on both event tasks and resource events
before this matcher could be enabled.

The dispatched input keeps authority explicit: the stored task text remains a
user-authored instruction, the matching normalized event is system-authored
input, and bounded provider text remains untrusted data.

Event tasks make the creator's connected credentials available by default when
the work needs user-bound authorization. The creator may require system
credentials instead. Only the creator may enable or re-enable creator mode; any
conversation manager may disable it, and another user's executable task edit
clears it. Event execution remains a system actor, with creator credentials
bound to the exact event task.

Management results include creator attribution and whether the registered
trigger is currently available from the enabled plugin catalog. An unavailable
trigger remains stored and may be deleted or edited, but it cannot receive
events until its plugin registration is enabled again.
