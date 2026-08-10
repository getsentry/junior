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

## Messages

`message/` is the isolated Slack message projection module. It converts typed
Chat SDK messages and tolerated raw Slack fields into small, plain values used
by Junior. `content.ts` is the entry point for agent-visible text and attachment
presence; `blocks.ts` and `attachments.ts` own the deterministic raw projections.

Validate unknown event envelopes at ingress or persistence boundaries. Keep
block and attachment projections tolerant of fields and element types Junior
does not consume so Slack can add payload fields without breaking message text.
Runtime modules should consume the `MessageContent` projection rather than
inspect `message.raw` or assemble attachment text themselves.

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

## Tools And Tool Support

- `tools/` holds concrete model-facing tool definitions and executors only.
  Keep one tool per file.
- Shared helpers used by those tools live in `tool-support/` (for example
  channel access checks, channel name resolution, canvas/list API helpers, and
  Slack tool context). Do not put reusable helpers under `tools/`.

## Boundaries

- Slack modules must not import runtime modules.
- Shared services receive small Slack ports instead of SDK clients.
- Slack SDK types stay inside the adapter.
- Do not add bespoke `chat.update` streaming loops unless Slack imposes a hard
  limitation; the standard reply path consumes finalized or iterable text.

Follow `../../../../../policies/provider-boundaries.md`,
`../../../../../policies/tool-design.md`, and the local `slack-development`
skill for Slack-specific implementation work.
