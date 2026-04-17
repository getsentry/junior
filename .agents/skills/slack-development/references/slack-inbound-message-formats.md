# Slack Inbound Message Formats

## Scope

How raw Slack Events API payloads represent mentions, thread identifiers, and
assistant lifecycle events.

Use this file for raw Slack payload behavior. For Chat SDK handler field contracts, use:
`${CLAUDE_SKILL_ROOT}/references/chat-sdk-payload-contract.md`.

## Event selection

1. Use `app_mention` to capture explicit mentions of the app in channels.
2. Use `message.*` events (for example, `message.channels`) for general thread/channel traffic.
3. Use `message.im` for direct messages to the app.
4. Use `assistant_thread_started` and `assistant_thread_context_changed` for Slack assistant container lifecycle.
5. Expect message events to include additional optional fields depending on subtype/context.

## Thread identity notes

1. `app_mention` and other non-DM message events carry `ts` and may also carry `thread_ts`.
2. `message.im` carries `ts` and may omit `thread_ts` on the first DM message.
3. Slack assistant lifecycle events do not use top-level `channel`/`thread_ts`; they carry `assistant_thread.channel_id` and `assistant_thread.thread_ts`.
4. When debugging raw payload issues, distinguish "reply-thread identity" from "assistant-thread API eligibility". They are related but not identical.

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
3. Treat `message.im` as the DM-specific path and verify whether the live event actually carries `thread_ts`.
4. Treat assistant lifecycle events as their own payload family rather than normal message events.
5. Do not rely on deprecated envelope fields (`authed_users`, `authed_teams`) for routing.
6. If routing through Chat SDK, prefer normalized fields (for example `message.isMention`) instead of re-parsing raw event JSON.

## Source links

- Slack `app_mention` event: https://docs.slack.dev/reference/events/app_mention/
- Slack `message.im` event: https://docs.slack.dev/reference/events/message.im
- Slack `message.channels` event: https://docs.slack.dev/reference/events/message.channels/
- Slack `assistant_thread_started` event: https://docs.slack.dev/reference/events/assistant_thread_started
- Slack `assistant_thread_context_changed` event: https://docs.slack.dev/reference/events/assistant_thread_context_changed/
- Slack Events API: https://docs.slack.dev/apis/events-api/
- Slack message formatting (entities): https://docs.slack.dev/messaging/formatting-message-text/
