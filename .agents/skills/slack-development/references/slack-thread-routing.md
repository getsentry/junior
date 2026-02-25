# Slack Thread Routing

## Scope

Deterministic routing pattern for subscribed-thread bots so mentions are handled before any passive detector.

## Routing order

1. Ignore messages from the bot itself.
2. Normalize user text (strip only leading bot mention token/name forms).
3. Check deterministic explicit-mention match:
- `@bot-name`
- `<@BOT_USER_ID>`
- `<@BOT_USER_ID|bot-name>`
4. If explicit mention is true, reply immediately (skip passive classifier).
5. If explicit mention is false, run passive reply classifier.
6. If classifier errors, fail closed (`no reply`) and log a concrete reason.

## Bot identity handling

1. Prefer bot user ID matching over name-only matching.
2. Source bot ID from runtime/app config or Slack API identity lookup.
3. Avoid brittle behavior that depends only on display-name regexes.

## Logging expectations

1. Always record routing reason for skipped replies.
2. Include correlation fields (thread/channel/user/run IDs) so no-reply decisions are debuggable.

## Source links

- Slack mention entity format: https://docs.slack.dev/messaging/formatting-message-text/
- Slack `app_mention` event: https://docs.slack.dev/reference/events/app_mention/
- Slack `message.channels` event: https://docs.slack.dev/reference/events/message.channels/
