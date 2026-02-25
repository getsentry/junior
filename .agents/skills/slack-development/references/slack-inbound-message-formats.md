# Slack Inbound Message Formats

## Scope

How raw Slack Events API payloads represent mentions and message text.

Use this file for raw Slack payload behavior. For Chat SDK handler field contracts, use:
`${CLAUDE_SKILL_ROOT}/references/chat-sdk-payload-contract.md`.

## Event selection

1. Use `app_mention` to capture explicit mentions of the app in channels.
2. Use `message.*` events (for example, `message.channels`) for general thread/channel traffic.
3. Expect message events to include additional optional fields depending on subtype/context.

## Mention/entity format in text

1. Slack represents user mentions in text as entity tokens such as `<@U012AB3CD>`.
2. IDs are the stable target for mention matching; names are presentation-level.
3. In raw payload handling, avoid display-name routing logic.

## Event envelope notes

1. Events are delivered in the Events API wrapper and can include `authorizations`/`event_context`.
2. Do not build new logic on deprecated wrapper fields like `authed_users` and `authed_teams`.

## Practical checks when handling raw events

1. Use `app_mention` as an explicit-mention trigger event.
2. Treat `message.*` events as broader message flow and thread traffic.
3. Do not rely on deprecated envelope fields (`authed_users`, `authed_teams`) for routing.
4. If routing through Chat SDK, prefer normalized fields (for example `message.isMention`) instead of re-parsing raw event JSON.

## Source links

- Slack `app_mention` event: https://docs.slack.dev/reference/events/app_mention/
- Slack `message.channels` event: https://docs.slack.dev/reference/events/message.channels/
- Slack Events API: https://docs.slack.dev/apis/events-api/
- Slack message formatting (entities): https://docs.slack.dev/messaging/formatting-message-text/
