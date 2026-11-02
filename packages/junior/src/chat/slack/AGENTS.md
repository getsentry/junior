# Slack Adapter

- Do not add custom `chat.update` streaming loops unless Slack forces it.
- Runtime code reads `MessageContent` from `message/content.ts`, not
  `message.raw`. Block and attachment projections accept unknown fields.
- Plain channel names resolve only against stored destinations. Do not scan
  Slack with `conversations.list`.
- Reactions and status messages are progress UI, not delivery contracts.
- OAuth links and other private authorization data use private delivery.

## Work Object Cards

- The Slack app needs Work Object Previews for Item and Task, and the
  `entity_details_requested` event at `/api/webhooks/slack`.
- `external_ref` encoding does not grant access or hide the reference.
- Slack can refresh shared previews from detail data. Do not put
  viewer-specific labels, credential data, or viewer-only provider fields in
  previews or details.
- Details show saved facts, not a live provider lookup. Do not change saved
  facts or dashboard cards to make Slack previews smaller.
- Payload tests do not prove Slack rendering. Check changed previews manually
  in a test Slack Conversation.
