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
