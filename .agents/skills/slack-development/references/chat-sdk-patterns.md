# Chat SDK Slack Patterns

## Scope

Implementation patterns for responsive Slack UX in Chat SDK based bots.

## Long-running interaction pattern

Repository-specific policy:

1. Start with immediate feedback:

- prefer assistant status as the primary in-flight progress surface
- use `thread.startTyping(...)` only when the current surface genuinely supports it and it does not conflict with the repository delivery contract

2. Keep visible reply text finalized:

- do not treat incremental `thread.post(textStream)` output as the default correctness path in this repository
- deliver the visible Slack reply after planning, chunking, and formatting are finalized

3. Emit progress transitions for multi-step/tool-heavy work through assistant status:

- "searching sources"
- "fetching details"
- "drafting response"

4. End with a complete final answer and clear failure handling.

## Why this pattern

1. Avoids "silent" multi-minute runs.
2. Improves user trust during tool execution.
3. Keeps Slack-visible text aligned with the finalized reply contract.

## Slack adapter capabilities to use

1. `thread.startTyping(...)` for typing/status feedback when the current surface and contract allow it.
2. `thread.postEphemeral(user, message, { fallbackToDM })` for messages visible only to one user.
3. Optional Assistants API status features when the current Slack status/title scopes and assistant events are configured. Slack's status scope rules have changed recently, so verify the current docs before assuming `assistant:write` is required.
4. Native stream support through `thread.post(asyncIterable)` exists, but in this repository it is not the baseline delivery contract for Slack replies.

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
3. Prefer one finalized response plan per user turn over many separate short messages.

## Sources

- Chat SDK streaming guide: https://chat-sdk.dev/docs/streaming
- Chat SDK Slack adapter guide: https://chat-sdk.dev/docs/adapters/slack
- Hono webhook pattern in Chat SDK guide: https://chat-sdk.dev/docs/guides/slack-hono
- Slack `assistant.threads.setStatus` docs: https://docs.slack.dev/reference/methods/assistant.threads.setStatus
- Slack status scope update: https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/
- AI Gateway web search capabilities: https://vercel.com/docs/ai-gateway/capabilities/web-search
