# Slack Adapter

Slack code owns Slack ingress context, assistant-thread status, outbound
formatting, and Slack API error mapping. It does not own agent decisions or
runtime orchestration.

## Ingress And Context

- Normalize direct messages, channel mentions, assistant threads, retries, and
  subscribed events before routing.
- Preserve team, channel, thread, message, actor, and retry identity explicitly.
- Acknowledge Slack within its request deadline after durable work is accepted.
- Duplicate Slack deliveries must converge on the same durable work rather than
  create duplicate turns.

## Delivery

- Post the primary finalized reply in the originating conversation context.
- Translate Junior Markdown to Slack `mrkdwn` only at the outbound boundary.
- Continue oversized replies without splitting code fences into invalid
  fragments.
- Upload files only through validated runtime artifacts; do not trust arbitrary
  model-provided paths or destinations.
- Reactions and status messages are progress UI, not completion contracts.
- OAuth links and other private authorization material use private delivery.
- Recoverable reply writes carry only an opaque `junior_delivery` marker. They
  are attempted once; ambiguous writes are reconciled through one
  `conversations.replies` page per invocation so durable orchestration can
  persist cursors and honor Slack's rate limit without risking duplicate posts.
- Reconciliation validates the marker and the current app/bot identity. Read
  errors remain unresolved and never authorize a repost. Permanent API
  rejections use a long operator-recovery backoff; rate limits continue to
  honor Slack's `Retry-After`.

### Recoverable Delivery Ownership

Ordinary finalized assistant replies close the external-acceptance gap through
the Slack-owned pending-delivery outbox. Private authorization, continuation,
and nonstandard notice paths are not covered by that outbox.

`delivery-command.ts` owns the strict persisted Slack reply command and progress
schemas. `delivery-outbox.ts` owns fenced SQL control state and atomic
terminalization. `recoverable-delivery.ts` advances or reconciles that state
without rerunning the model, while `outbound.ts` keeps Slack API results and
error classification inside the adapter.

Creating an intent first commits the generated model-continuity boundary to the
canonical conversation event log. The outbox stores only its committed and
rollback event cursors, never a Pi transcript. Slack acceptance still gates the
visible assistant-message fact; a definitive rejection opens a rollback epoch
when no part was accepted, so the wholly undelivered generation remains audit
history but not live Pi context. A partial multipart delivery retains the model
generation because its tool calls and side effects happened, records the
accepted Slack prefix as the visible assistant fact, and closes with a
`delivery_failed` turn terminal so the undelivered tail is explicit in history.

At most one unresolved delivery exists per conversation, so newer input cannot
bypass older delivery. A stale `posting` state becomes `uncertain` and cannot
be posted again until reconciliation explicitly marks it repostable after its
grace period. Terminalization persists canonical visible-message and turn facts
and deletes the pending row in one transaction. Only `turn_failed` with
`delivery_failed` means Slack rejected delivery; recovery without a live intent
also requires the atomically finalized visible assistant message before it
classifies another terminal as accepted. Permanent reconciliation rejections
remain uncertain and use an operator-recovery backoff rather than authorizing a
duplicate post.

`outbound.ts` owns Slack API calls and retry classification. `mrkdwn.ts` owns
format conversion. `assistant-thread/` owns assistant-thread lifecycle and
status rendering.

## Boundaries

- Slack modules must not import runtime modules.
- Shared services receive small Slack ports instead of SDK clients.
- Slack SDK types stay inside the adapter.
- Do not add bespoke `chat.update` streaming loops unless Slack imposes a hard
  limitation; the standard reply path consumes finalized or iterable text.

Follow `../../../../../policies/provider-boundaries.md` and the local
`slack-development` skill for Slack-specific implementation work.
