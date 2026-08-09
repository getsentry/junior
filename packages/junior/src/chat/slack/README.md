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

- Post each completed tool-free assistant message in the originating
  conversation context, preserving destination-visible model message
  boundaries. Attach the compact conversation footer on the last chunk of
  each visible assistant message. Tool-bearing assistant text remains agent
  history; explicit progress uses the status surface.
- Translate Junior Markdown to Slack `mrkdwn` only at the outbound boundary.
- Continue oversized replies without splitting code fences into invalid
  fragments.
- Upload files only through validated runtime artifacts; do not trust arbitrary
  model-provided paths or destinations.
- Reactions and status messages are progress UI, not assistant-message delivery
  contracts.
- OAuth links and other private authorization material use private delivery.
- Explicit Slack API rejections fail delivery. Transient or ambiguous failures
  resume the agent from its latest saved history; a reply may be
  duplicated if Slack accepted it before the failure became visible.

`reply.ts` owns destination-visible reply chunking, conversation footers, and
the `sendSlackReply` helper. `outbound.ts` owns Slack API calls and immediate
transport retries. `errors.ts` owns reply-failure classification. `mrkdwn.ts`
owns format conversion. `assistant-thread/` owns assistant-thread lifecycle and
status rendering.

## Boundaries

- Slack modules must not import runtime modules.
- Shared services receive small Slack ports instead of SDK clients.
- Slack SDK types stay inside the adapter.
- Do not add bespoke `chat.update` streaming loops unless Slack imposes a hard
  limitation; the standard reply path consumes finalized or iterable text.

Follow `../../../../../policies/provider-boundaries.md` and the local
`slack-development` skill for Slack-specific implementation work.
