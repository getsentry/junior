# Chat SDK Slack Patterns

## Scope

Implementation patterns for responsive Slack UX in Chat SDK based bots.

## Long-running interaction pattern

1. Start with immediate feedback:
- call `thread.startTyping("Working...")` when appropriate
- or post a short acknowledgement message when typing is insufficient
2. Stream final output:
- use AI SDK streaming (`streamText` or equivalent)
- pass `textStream` to `thread.post(textStream)` for incremental Slack updates
3. Emit progress transitions for multi-step/tool-heavy work:
- "searching sources"
- "fetching details"
- "drafting response"
4. End with a complete final answer and clear failure handling.

## Why this pattern

1. Avoids "silent" multi-minute runs.
2. Improves user trust during tool execution.
3. Produces better perceived latency without sacrificing completeness.

## Slack adapter capabilities to use

1. `thread.startTyping(...)` for typing/status feedback.
2. Native stream support through `thread.post(asyncIterable)` on Slack.
3. Optional Assistants API status features when `assistant:write` and assistant events are configured.

## Integration notes for this repository

1. Keep webhook processing asynchronous with `waitUntil` in the Next.js webhook route.
2. Keep external search behavior aligned with AI Gateway-native tools.
3. Prefer one streaming response per user turn over many separate short messages.

## Sources

- Chat SDK streaming guide: https://chat-sdk.dev/docs/streaming
- Chat SDK Slack adapter guide: https://chat-sdk.dev/docs/adapters/slack
- Next.js webhook pattern in Chat SDK guide: https://chat-sdk.dev/docs/guides/slack-nextjs
- AI Gateway web search capabilities: https://vercel.com/docs/ai-gateway/capabilities/web-search

