# Slack Thread Routing

## Scope

Deterministic routing pattern for subscribed-thread bots so mentions are handled before any passive detector.

## Routing order

1. Ignore messages from the bot itself.
2. Normalize user text (strip only leading bot mention token/name forms).
3. Use Chat SDK mention signal first:
- in `onNewMention`, treat the event as explicit mention
- in `onSubscribedMessage`, use `message.isMention === true` for explicit mention
4. If explicit mention is true, reply immediately (skip passive classifier).
5. If explicit mention is false, run passive reply classifier.
6. If classifier errors, fail closed (`no reply`) and log a concrete reason.

## Bot identity handling

1. Avoid display-name parsing when Chat SDK already provides `message.isMention`.
2. Only parse raw mention entities (`<@U...>`) in fallback paths where SDK mention metadata is unavailable.
3. Keep mention detection logic adapter-aware and deterministic.

## Logging expectations

1. Always record routing reason for skipped replies.
2. Include correlation fields (thread/channel/user/run IDs) so no-reply decisions are debuggable.

## Source links

- Slack mention entity format: https://docs.slack.dev/messaging/formatting-message-text/
- Slack `app_mention` event: https://docs.slack.dev/reference/events/app_mention/
- Slack `message.channels` event: https://docs.slack.dev/reference/events/message.channels/
- Chat SDK `onSubscribedMessage`: https://chat-sdk.dev/docs/reference/chat/on-subscribed-message
