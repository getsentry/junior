# Slack Inbound Message Formats

## Scope

How Slack event payloads represent mentions and message text for bot routing decisions.

## Event selection

1. Use `app_mention` to capture explicit mentions of the app in channels.
2. Use `message.*` events (for example, `message.channels`) for general thread/channel traffic.
3. Expect message events to include additional optional fields depending on subtype/context.

## Mention format in text

1. Slack represents user mentions in text as entity tokens such as `<@U012AB3CD>`.
2. Routing logic should parse mention entity tokens and compare IDs, not display names.
3. Display names can vary; IDs are stable routing keys.

## Event envelope notes

1. Events are delivered in the Events API wrapper and can include `authorizations`/`event_context`.
2. Do not build new logic on deprecated wrapper fields like `authed_users` and `authed_teams`.

## Practical implementation checks

1. Explicit bot mention in thread message should be a deterministic reply path.
2. Passive classifiers should run only after deterministic mention checks.
3. Log the routing reason (`explicit mention`, `classifier false`, `classifier error`) for each no-reply decision.

## Source links

- Slack `app_mention` event: https://docs.slack.dev/reference/events/app_mention/
- Slack `message.channels` event: https://docs.slack.dev/reference/events/message.channels/
- Slack Events API: https://docs.slack.dev/apis/events-api/
- Slack message formatting (entities): https://docs.slack.dev/messaging/formatting-message-text/
