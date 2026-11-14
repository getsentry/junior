# Slack Formatting Reference (Legacy)

## Scope

Legacy compatibility reference. Prefer the split guides below for implementation work.

## Use these references instead

1. Output formatting rules: `${CLAUDE_SKILL_ROOT}/references/slack-output-formatting.md`
2. Inbound event/message formats: `${CLAUDE_SKILL_ROOT}/references/slack-inbound-message-formats.md`
3. Thread reply routing rules: `${CLAUDE_SKILL_ROOT}/references/slack-thread-routing.md`

## Previous consolidated notes

1. Slack uses `mrkdwn`, not full CommonMark.
2. Escape only `&`, `<`, and `>` in text that can contain user content.
3. Convert newline intent explicitly with `\n`.
4. Do not rely on native ordered/unordered Markdown list parsing; format lists as plain lines (for example, `- item`).
5. Use Slack entity syntax when behavior must be deterministic:
- Links: `<https://example.com|label>`
- User mentions: `<@U123456>`
- Channel links: `<#C123456>`
- Dates: `<!date^unix_ts^{date_short} {time}|fallback>`

## Accessibility requirements

1. When using Block Kit, ensure top-level fallback text remains useful for notifications and assistive technologies.
2. Do not hide critical information only inside decorative blocks.

## Common failure modes

1. Escaping too much (breaking intended formatting).
2. Assuming Markdown lists/tables render like GitHub.
3. Sending raw URLs/mentions when stable entity rendering is required.
4. Omitting meaningful fallback text for block-heavy messages.

## Primary sources

- Slack formatting guide: https://docs.slack.dev/messaging/formatting-message-text/
- Slack `chat.postMessage`: https://docs.slack.dev/reference/methods/chat.postMessage
- Slack mrkdwn text object: https://docs.slack.dev/reference/block-kit/composition-objects/text-object/
- Slack date formatting: https://docs.slack.dev/messaging/formatting-message-text/#date-formatting
