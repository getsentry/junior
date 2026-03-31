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
3. `thread.postEphemeral(user, message, { fallbackToDM })` for messages visible only to one user.
4. Optional Assistants API status features when `assistant:write` and assistant events are configured.

## Ephemeral messages

The Chat SDK supports ephemeral messages natively via `thread.postEphemeral()`:

```typescript
await thread.postEphemeral(
  userId,
  { raw: "Only you can see this" },
  { fallbackToDM: false },
);
```

- `user`: Slack user ID (string) or `Author` object.
- `message`: `AdapterPostableMessage` — use `{ raw: "..." }` for mrkdwn or `{ markdown: "..." }` for auto-converted markdown.
- `options.fallbackToDM`: If `true`, sends a DM when the platform doesn't support ephemeral. If `false`, returns `null`.
- Returns `EphemeralMessage | null`.

Use ephemeral messages for:

- OAuth authorization links (contain user-specific tokens — should not be visible to other channel members).
- Confirmation/error messages that are only relevant to one user.
- Sensitive information that shouldn't persist in thread history.

Note: Ephemeral messages are only available when you have a thread handle (e.g. in `onNewMention`/`onSubscribedMessage` handlers). Host-side code without a thread handle (like jr-rpc command handlers or OAuth callback routes) must use `SLACK_BOT_TOKEN` with direct `chat.postEphemeral`/`chat.postMessage` API calls instead.

## Integration notes for this repository

1. Keep webhook processing asynchronous with `waitUntil` in the webhook route.
2. Keep external search behavior aligned with AI Gateway-native tools.
3. Prefer one streaming response per user turn over many separate short messages.

## Sources

- Chat SDK streaming guide: https://chat-sdk.dev/docs/streaming
- Chat SDK Slack adapter guide: https://chat-sdk.dev/docs/adapters/slack
- Hono webhook pattern in Chat SDK guide: https://chat-sdk.dev/docs/guides/slack-hono
- AI Gateway web search capabilities: https://vercel.com/docs/ai-gateway/capabilities/web-search
