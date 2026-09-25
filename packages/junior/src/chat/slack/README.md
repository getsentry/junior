# Slack Adapter

Low-level Slack code owns Slack ingress data, assistant-thread status, outbound
formatting, and Slack API error mapping. The Slack provider layer in
`../providers/slack/` combines these capabilities with the native agent runtime.

## Ingress And Context

- Normalize direct messages, channel mentions, assistant threads, retries, and
  subscribed events before routing.
- Preserve team, channel, thread, message, actor, and retry identity explicitly.
- Acknowledge Slack within its request deadline after durable work is accepted.
- Duplicate Slack deliveries must converge on the same durable work rather than
  create duplicate turns.
- Add the processing reaction for new mentions and DMs before publishing them
  to the mailbox. Serialize ingress per thread so retries cannot restore a
  completed reaction. This optional UI gets one one-second attempt; failure
  must not reject the input. The worker retries and owns completion. Passive
  messages wait for the reply decision. Thread stops clear queued reactions.

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
  fragments. With no inbound thread, later chunks reply under the first chunk
  so the channel only gets one top-level message.
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
transport retries. Saved cards use Slack Work Objects through
`chat.postMessage.metadata.entities`, not Block Kit attachments. Automation
previews use `slack#/entities/item`. They show the title, trigger, and any warning.
The opaque ID stays in `external_ref`; operation badges and full instructions
stay out of the preview. Deleted objects render nothing; the normal reply owns
the confirmation. Objects without a dashboard URL use compact text instead.

Enable **Work Object Previews → Item and Task** in the Slack app before deploying this
renderer. Subscribe to `entity_details_requested` at `/api/webhooks/slack`.
Slack owns the card layout and app attribution. The app icon supplies the card
icon. Opening or refreshing the detail panel loads current Automation facts
and calls `entity.presentDetails`. The stored Slack identity selects the User;
the Automations view access rules allow owned and public-workspace objects.
Missing, deleted, and inaccessible objects all return `not_found` without facts.
Details use the dashboard Automation summary. Instructions keep Markdown and
line breaks; timestamps use Slack's local time display. Item entities use
`custom_fields` in display order, not task-specific `fields`.
New message previews stay compact. Slack can refresh them from detail metadata,
so do not send viewer-specific labels such as "you" or credential data.
Object annotation previews use Task for tasks and Item for code changes and
other objects. Their `external_ref` identifies the Conversation, plugin, and
object key, not a Message snapshot. The ID is a UTF-8 JSON tuple encoded as
base64url without padding; the detail handler decodes it. Slack rejects raw JSON
IDs. Encoding does not grant access or hide the reference. Details show the
latest saved annotation, not a live provider lookup. Opening or refreshing details can update an earlier
Slack preview. The saved Message and web transcript remain unchanged. Annotations
contain last saved facts; not every provider change updates them.
The viewer must have a linked User, belong to the same Slack workspace, and have
access to that Conversation. Missing and inaccessible annotations return
`not_found`. Only already-shared annotation facts enter these details; do not add
viewer-only provider fields because Slack can refresh shared previews from them.
Automation details retain their current authoritative lookup and access checks.
Link unfurls and actions are not implemented.
See [Slack's detail API and Item schema](https://docs.slack.dev/messaging/work-objects-implementation#implementation-flexpane).

`work-object.ts` owns the Item/Task schema and its TypeScript types. Message posts
and both detail handlers validate metadata before sending it. Reference IDs use
Junior's conservative `[A-Za-z0-9_-]+` subset. Items cannot contain Task fields;
custom fields require values of the matching type. Unknown fields fail validation.

`post-warning.ts` reports accepted Slack warnings without retrying the message.

Before rollout, check a GitHub issue, pull request, and Linear issue in a test
Slack Conversation with Item and Task previews enabled. Check initial rendering,
open details, and denied access. After a saved annotation changes, refresh the
Slack details and compare the preview with the unchanged web transcript. Payload
tests do not prove Slack's rendering or refresh behavior.

Reply text and accessible fallback text still travel together. Card-only chunks
keep a context block so Slack does not also display the notification fallback
as body text. Conversation footer links retain the diagnostic ID as their label.
Installs without a conversation URL show the same ID without a link.
`errors.ts` owns reply-failure classification. `mrkdwn.ts` owns format conversion. `assistant-thread/` owns assistant-thread lifecycle and
status rendering.

## Tools And Tool Support

- `tools/` holds concrete model-facing tool definitions and executors only.
  Keep one tool per file.
- Shared helpers used by those tools live in `tool-support/` (for example
  channel access checks, channel id parsing, canvas/list API helpers, and Slack
  tool context). Do not put reusable helpers under `tools/`.
- Channel tool params accept id-bearing forms first: exact ids (`C123`), Slack
  mentions (`<#C123>` / `<#C123|name>`), and Junior slack references
  (`slack:C123`). Plain names may resolve only against destinations Junior
  already stored for this workspace (`junior_destinations.display_name`). Do not
  scan Slack with `conversations.list` to invent completeness. Use public search
  when the model needs to discover an unknown channel.

## Boundaries

- Low-level Slack modules must not import runtime modules.
- The Slack provider layer may call provider-neutral runtime contracts. It must
  not replace the native agent loop.
- Shared services receive small Slack ports instead of SDK clients.
- Slack SDK types stay inside the adapter.
- Do not add bespoke `chat.update` streaming loops unless Slack imposes a hard
  limitation; the standard reply path consumes finalized or iterable text.

Follow `../../../../../policies/provider-boundaries.md`,
`../../../../../policies/tool-design.md`, and the local `slack-development`
skill for Slack-specific implementation work.
