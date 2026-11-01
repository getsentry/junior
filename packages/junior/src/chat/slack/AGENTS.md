# Slack Adapter

Low-level Slack code owns Slack ingress data, assistant-thread status,
outbound formatting, Work Object cards, Slack tools, and Slack API error
mapping. `../providers/slack/` joins these parts with the agent runtime.

Follow `policies/provider-boundaries.md`, `policies/tool-design.md`, and the
`slack-development` skill.

## Boundaries

- Low-level Slack modules must not import runtime modules.
- The Slack provider layer may call provider-neutral runtime contracts. It
  must not replace the native agent loop.
- Shared services get small Slack ports, not SDK clients. Slack SDK types stay
  in the adapter.
- Do not add custom `chat.update` streaming loops unless Slack forces it.
- `tools/` holds one model-facing tool per file. Shared helpers go in
  `tool-support/`.

## Ingress

- Keep team, channel, thread, message, Actor, and retry identity explicit.
- Acknowledge Slack within its deadline, after durable work is accepted.
  Duplicate deliveries must converge on the same durable work.
- The processing reaction is optional UI. It gets one short attempt before the
  mailbox publish. A failure must not reject the input. Ingress is serial for
  each thread, so a retry cannot restore a completed reaction.
- Runtime code reads `MessageContent` from `message/content.ts`. Do not read
  `message.raw`. Block and attachment projections must accept fields that
  Junior does not use.
- Channel tool params accept ids, mentions, and `slack:C123` first. Plain
  names resolve only against stored destinations. Do not scan Slack with
  `conversations.list`.

## Delivery

- Every visible Turn post goes through `sendSlackReply` in `reply.ts`, so each
  post has the Conversation footer.
- Get the channel and thread from `resolveSlackReplyTarget`. Do not parse the
  Conversation id for delivery. An Automation or Watch Conversation can own a
  thread whose id is not a Slack thread id. The ast-grep rules
  `no-raw-slack-turn-post` and `no-slack-thread-from-conversation-id` enforce
  this.
- Convert Markdown to `mrkdwn` only at the outbound boundary (`mrkdwn.ts`).
- Do not split code fences across chunks. With no inbound thread, later
  chunks reply under the first chunk.
- Upload files only through validated runtime artifacts. Do not trust
  model-provided paths or destinations.
- Reactions and status messages are progress UI, not delivery contracts.
- OAuth links and other private authorization data use private delivery.
- Explicit Slack API rejections fail delivery. Transient or unclear failures
  resume from saved history, so a reply can be duplicated.

## Work Object Cards

- Cards use Slack Work Objects (`work-object.ts`), not Block Kit attachments.
  Validate metadata before each send. Unknown fields fail validation.
- The Slack app needs Work Object Previews for Item and Task, and the
  `entity_details_requested` event at `/api/webhooks/slack`.
- `external_ref` is a base64url JSON reference. Encoding does not grant access
  or hide the reference.
- Detail handlers need a linked User in the same Slack workspace with access
  to the object. Missing, deleted, and inaccessible objects all return
  `not_found` with no facts.
- Slack can refresh shared previews from detail data. Do not put
  viewer-specific labels, credential data, or viewer-only provider fields in
  previews or details.
- Annotation details show the latest saved facts, not a live provider lookup.
  Do not change saved facts or dashboard cards to make Slack previews smaller.
- Payload tests do not prove Slack rendering. Check previews manually in a
  test Slack Conversation when you change them.
