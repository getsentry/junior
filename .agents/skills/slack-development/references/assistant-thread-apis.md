# Assistant-Thread APIs

## Scope

Canonical local synthesis of the Slack and Chat SDK APIs this repository
relies on for Slack assistant-thread lifecycle, status, and title behavior.

Use this file before changing:

- assistant-thread status/title behavior
- DM versus channel-thread Slack context handling
- assistant lifecycle event handling
- Slack skill guidance that refers to `assistant.threads.*`

This file intentionally separates:

1. vendor-documented API facts
2. repository policy layered on top
3. concrete implementation seams in this repo

## External API Surfaces We Rely On

### Slack Events API

1. `app_mention`

- Used for explicit mentions in channels.
- Carries `channel`, `ts`, and optional `thread_ts`.
- Messages in direct messages are not delivered through `app_mention`.

2. `message.im`

- Used for DM traffic to the bot.
- Carries `channel`, `ts`, and may omit `thread_ts` on the first DM message.
- Slack AI/app-thread continuation in DMs depends on `thread_ts` when present.

3. `assistant_thread_started`

- Carries `assistant_thread.channel_id`, `assistant_thread.thread_ts`, and optional `assistant_thread.context.channel_id`.
- Used to initialize suggested prompts and thread-title state for Slack assistant threads.

4. `assistant_thread_context_changed`

- Carries the same `assistant_thread.*` shape as the start event.
- Used to refresh context without resetting an established conversation title.

### Slack Web API

1. `assistant.threads.setStatus`

- Requires `channel_id` and `thread_ts`.
- Slack clears status automatically when a reply is posted.
- Sending an empty `status` clears the indicator explicitly.
- Slack currently accepts either `chat:write` or `assistant:write` for this method. This changed in March 2026 and may change again, so re-check the live docs before changing scope guidance.

2. `assistant.threads.setTitle`

- Requires `channel_id`, `thread_ts`, and `title`.
- Still documented as an assistant-thread/title API, primarily for app-thread history in DMs.
- `assistant:write` remains the documented scope for this method.

3. `assistant.threads.setSuggestedPrompts`

- Requires `channel_id`, `thread_ts`, and prompt payloads.
- Used from the lifecycle path when Slack starts or refreshes an assistant thread.

### Chat SDK Slack Adapter

1. `setAssistantStatus(channelId, threadTs, status, loadingMessages?)`

- Thin adapter wrapper around Slack `assistant.threads.setStatus`.

2. `setAssistantTitle(channelId, threadTs, title)`

- Thin adapter wrapper around Slack `assistant.threads.setTitle`.

3. `startTyping(threadId, status?)`

- Available in the adapter, but this repository does not use it as the baseline visible Slack progress surface.

## Repository Policy

1. Assistant status is the primary in-flight progress surface. Visible reply text is finalized before posting.
2. For non-DM message events, the live assistant-thread key is `channel + (thread_ts ?? ts)`.
3. For `message.im`, assistant-thread status/title updates require an explicit live `thread_ts`. Do not synthesize DM assistant roots from generic `ts` or persisted state.
4. For lifecycle events, use `assistant_thread.channel_id + assistant_thread.thread_ts`.
5. Reply continuity and assistant-thread API eligibility are separate concerns. A persisted thread root can be valid for reply threading without being valid for `assistant.threads.*`.
6. Conversation-specific thread titles are DM-only in the normal reply path and come from the earliest human message the runtime actually knows about for that thread.
7. `assistant_thread_context_changed` may refresh prompts/context, but must not clobber an already established conversation title.

## Implementation Map In This Repo

1. Live assistant-thread context selection:

- `packages/junior/src/chat/runtime/thread-context.ts`
- `getAssistantThreadContext()`

2. Status sending and token binding:

- `packages/junior/src/chat/slack/assistant-thread/status-send.ts`
- `packages/junior/src/chat/slack/assistant-thread/status.ts`
- `packages/junior/src/chat/slack/assistant-thread/status-scheduler.ts`

3. Lifecycle event handling:

- `packages/junior/src/chat/slack/assistant-thread/lifecycle.ts`
- `packages/junior/src/chat/runtime/slack-runtime.ts`

4. DM title generation and permission handling:

- `packages/junior/src/chat/slack/assistant-thread/title.ts`

5. Current delivery contract:

- `specs/slack-agent-delivery-spec.md`

## Audit Checklist

When changing code or guidance in this area, verify all of the following:

1. `app_mention` handling does not treat channel traffic like `message.im`.
2. Channel-thread first replies use the live `ts` when `thread_ts` is absent.
3. DM status/title updates are skipped when the current `message.im` lacks explicit `thread_ts`.
4. Lifecycle events use `assistant_thread.channel_id` and `assistant_thread.thread_ts`.
5. `assistant.threads.setStatus` calls never receive adapter-scoped `slack:<channel>` IDs.
6. Title generation stays best effort and does not block visible reply delivery.
7. Skill/docs wording does not hardcode stale scope assumptions for `setStatus`.

## Sources

- Slack `app_mention`: https://docs.slack.dev/reference/events/app_mention/
- Slack `message.im`: https://docs.slack.dev/reference/events/message.im
- Slack `assistant_thread_started`: https://docs.slack.dev/reference/events/assistant_thread_started
- Slack `assistant_thread_context_changed`: https://docs.slack.dev/reference/events/assistant_thread_context_changed/
- Slack `assistant.threads.setStatus`: https://docs.slack.dev/reference/methods/assistant.threads.setStatus
- Slack `assistant.threads.setTitle`: https://docs.slack.dev/reference/methods/assistant.threads.setTitle
- Slack status scope update: https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/
- Slack `chat:write` scope: https://docs.slack.dev/reference/scopes/chat.write/
- Slack AI app guidance: https://docs.slack.dev/ai/developing-ai-apps
- Chat SDK Slack adapter: https://chat-sdk.dev/adapters/slack
