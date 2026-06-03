# Slack Output Formatting

## Scope

How to format outbound Slack bot messages correctly using Slack-documented `mrkdwn` and message APIs.

## Rules

1. Treat Slack text as `mrkdwn`, not full CommonMark.
2. Escape only `&`, `<`, and `>` for dynamic text.
3. Use explicit `\n` for line breaks.
4. Use Slack entity syntax when behavior must be deterministic:
- User mention: `<@U123ABC456>`
- Channel link: `<#C123ABC456>`
- Link with label: `<https://example.com|example>`
- Date token: `<!date^unix_ts^{date_short} {time}|fallback>`
5. For structured block messages, ensure top-level `text` remains meaningful for notifications/accessibility.

## Avoid

1. Assuming GitHub-style Markdown list/table behavior.
2. Escaping all punctuation (it breaks intended rendering).
3. Depending on deprecated automatic parsing of user-entered mentions/channels in arbitrary text.

## Source links

- Slack message formatting: https://docs.slack.dev/messaging/formatting-message-text/
- Slack `chat.postMessage`: https://docs.slack.dev/reference/methods/chat.postMessage
- Slack mrkdwn text object: https://docs.slack.dev/reference/block-kit/composition-objects/text-object/
