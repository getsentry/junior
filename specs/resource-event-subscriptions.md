# Resource Event Subscriptions Spec

## Metadata

- Created: 2026-06-30
- Last Edited: 2026-06-30

## Purpose

Define conversation-bound subscriptions that let Junior receive provider
resource events for work it initiated or explicitly chose to watch.

The primitive is conversation-first: provider events are delivered as queued
conversation messages so the existing mailbox, lease, ordering, and
reply-completion contracts decide when the agent sees them.

## Scope

- Model-visible tools for subscribing the current conversation to resource
  events.
- Durable subscription records, indexes, TTL, cancellation, terminal status, and
  dedupe.
- Tool-result affordances that advertise a resource can be watched.
- Plugin-owned provider/resource/event normalization boundaries.
- Event delivery into the subscribed conversation mailbox.

## Non-Goals

- A generic workflow engine.
- Immediate steering, Pi `followUp`, or direct injection into an active model
  run.
- Provider-specific webhook payload contracts.
- Autonomous write actions beyond normal agent/tool permission rules.
- Manifest-declared event handlers in `plugin.yaml`.

## Contracts

### Product Boundary

A resource event subscription means:

> Deliver matching normalized resource events into this conversation later.

Matching events must be appended to the durable conversation mailbox and
processed at the next normal conversation boundary.

Rules:

1. Subscribed events are queued conversation messages, never immediate steering.
2. Event notifications must use the existing conversation execution path:
   append inbound mailbox message, send queue wake-up, acquire conversation
   lease, drain mailbox, run the normal destination worker.
3. If the conversation is already running, event messages wait in the mailbox
   with other pending inbound work.
4. If user messages and event messages are both pending, normal mailbox ordering
   applies.
5. Event delivery must not bypass final-reply, progress, tool-permission,
   continuation, or auth-pause rules.
6. Resource-event turns run as a system actor without an inferred human
   credential subject. They may use provider service-principal credentials for
   explicitly bot-owned operations, including repository-scoped GitHub App
   credentials for issue, pull request, and Git smart-HTTP branch writes.
7. Operations that require human identity still pause for explicit delegated
   authorization; a subscription does not inherit the subscriber's OAuth
   credential.
8. If a resource-event turn continues across execution slices, the stored
   `resource-event` system actor and credential context are preserved; resume
   must not require or fabricate a Slack user actor.

### Subscribable Resource Affordance

Action tools and resource-reading tools may return a `subscribable` hint:

```ts
interface SubscribableResource {
  label: string;
  provider: string;
  resourceRef: string;
  type: string;
  supportedEvents: string[];
  suggestedEvents?: string[];
}
```

This is only an affordance. The model must call the generic subscription tool
before any durable subscription exists.

Rules:

1. `resourceRef` is opaque to the model and provider-resolvable by runtime/plugin code.
2. `supportedEvents` names provider-defined normalized event types for that
   resource.
3. `suggestedEvents` should contain high-signal defaults appropriate for the
   action that produced the resource.
4. Tool results must not include provider webhook filters, Slack coordinates, or
   credentials in the subscribable hint.

### Core Subscription Tools

Core exposes model-visible tools scoped to the current conversation:

```ts
subscribeToResourceEvents({
  resourceRef,
  provider,
  resourceType,
  label,
  events,
  intent,
  ttlMs?
})
```

```ts
listResourceEventSubscriptions();
cancelResourceEventSubscription({ subscriptionId });
```

Rules:

1. Tools derive `conversationId` and destination from runtime-owned context.
2. Tool schemas must not accept Slack team ids, channel ids, thread timestamps,
   actor ids, credentials, or provider secrets.
3. `intent` is required and must summarize why this conversation wants the
   event. Event notifications render it back to the agent.
4. Core owns TTL defaults and enforces an upper bound.
5. Listing and cancellation are scoped to the current conversation.

### Durable Subscription Record

Core owns subscription records:

```ts
interface ResourceEventSubscription {
  id: string;
  status: "active" | "cancelled" | "completed";

  provider: string;
  resourceRef: string;
  resourceType: string;
  label: string;
  events: string[];
  intent: string;

  conversationId: string;
  destination: Destination;

  createdAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
}
```

Rules:

1. Core storage is the authority for conversation routing, TTL, cancellation,
   and terminal state.
2. Plugin storage may track provider-specific webhook or polling state, but it
   must not be the authority for whether a Junior conversation is subscribed.
3. Subscription ids must be deterministic enough to make duplicate subscribe
   calls for the same conversation/resource/event set idempotent.
4. Terminal provider events may mark subscriptions `completed` after the event
   notification is accepted into the mailbox.

### Plugin Boundary

The MVP public plugin-facing surface is the subscribable hint. Provider event
ingestion is an internal host-runtime boundary until a plugin-facing event
ingestion API exists.

Plugins can extend the system in one public way:

1. Return `SubscribableResource` hints from plugin tools.

Provider route code owns:

- provider webhook signature verification
- provider payload parsing
- provider-specific resource ref construction
- provider-specific event names and summaries
- optional polling fallback for providers without push events

Core owns:

- model-visible subscription tools
- subscription records and indexes
- conversation binding
- dedupe and TTL enforcement
- mailbox enqueueing
- final delivery behavior through existing conversation workers

Declarative `plugin.yaml` manifests must not register event handlers or
executable subscription behavior.

### Event Ingestion

Host runtime/provider route code passes normalized events to core:

```ts
ingestResourceEvent({
  provider,
  resourceRef,
  eventType,
  eventKey,
  occurredAtMs,
  trustedSummary,
  untrustedText?,
  terminal?
})
```

Rules:

1. `eventKey` must be stable for provider retries and duplicate deliveries.
2. `trustedSummary` is plugin/runtime-authored text derived from verified
   provider facts.
3. Provider-authored content such as comments, commit messages, workflow logs,
   and PR bodies must be rendered as untrusted content.
4. Core matches active subscriptions by provider, resource ref, and event type.
5. Core must not enqueue duplicate mailbox messages for the same subscription
   and event key.
6. Ingestion failure before mailbox acceptance should be retryable by the
   provider route or queue. Failure after mailbox acceptance must not create
   duplicate visible deliveries on retry.

### Event Notification Message

Core renders a synthetic conversation message with an explicit wrapper:

```text
[event notification]

A subscribed resource changed.

Subscription:
- resource: GitHub PR getsentry/junior#123
- event: checks.failed
- intent: Watch the PR Junior opened for CI failures.

Trusted event summary:
CI failed on workflow "test" for commit abc123.

Untrusted provider content:
...
```

Rules:

1. The notification is model-visible conversation context, not a user-authored
   command.
2. Metadata must identify the record as a resource event notification and carry
   subscription id, provider, resource ref, event type, and event key.
3. Event notifications should route through subscribed-thread handling when
   delivered to Slack conversations.
4. Runtime prompt guidance must tell the agent to use subscription intent to
   decide whether a reply or follow-up action is warranted.
5. Slack event notifications are synthetic mailbox messages, not native Slack
   messages. Their internal message ids must not be written to Slack `ts`,
   `message_ts`, or other Slack Web API timestamp fields, and they must not
   drive message-targeting Slack side effects such as automatic processing
   reactions.

### GitHub Pull Request MVP

The first provider implementation is GitHub pull requests created through
`github_createPullRequest`.

MVP events:

- `checks.failed`
- `checks.recovered`
- `comment.created`
- `review.approved`
- `review.changes_requested`
- `review.commented`
- `review_comment.created`
- `state.merged`
- `state.closed_unmerged`

`state.merged` and `state.closed_unmerged` are terminal for the subscription.

## Failure Model

1. Missing conversation context: subscription tool calls fail with a
   model-visible error.
2. Unsupported delivery destination: MVP subscription tools fail unless the
   current destination can receive queued conversation messages.
3. Duplicate provider event: core dedupe prevents duplicate mailbox messages.
4. Expired, cancelled, or completed subscription: ingestion does not enqueue a
   message.
5. Malformed provider event: provider code rejects before calling core
   ingestion.
6. Unavailable queue or state store: ingestion fails before acknowledging the
   provider delivery when possible.

## Observability

Resource event subscriptions should be diagnosable through safe runtime events:

- subscription created/cancelled/completed
- provider event matched/ignored
- event notification enqueued
- event notification deduped
- event notification enqueue failed

Attribute names follow `./instrumentation.md`, `./logging.md`,
`./tracing.md`, and `./otel-semantics.md`; provider-specific attributes should
use `app.resource_event.*` or provider semantic keys when they exist.

## Verification

- Component tests cover subscription storage, current-conversation scoping,
  event matching, queue enqueueing, dedupe, cancellation, expiry, and terminal
  completion.
- Integration tests cover Slack-visible event notifications through the real
  conversation worker once provider webhook routes are wired.
- GitHub plugin tests cover `github_createPullRequest` returning a
  `SubscribableResource` hint.
- Evals cover model behavior: subscribing when the user asks Junior to keep an
  eye on a resource, choosing high-signal suggested events, and treating event
  notifications as context rather than forced commands.

## Related Specs

- `./task-execution.md`
- `./agent-turn-handling.md`
- `./slack-agent-delivery.md`
- `./plugin.md`
- `./plugin-runtime.md`
- `./plugin-dispatch.md`
- `./scheduler.md`
