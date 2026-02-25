# Chat SDK Payload Contract

## Scope

Canonical payload guidance for `chat` handlers in this repository so routing code does not guess field shape.

## Documented message fields to use first

From the Chat SDK `Message` contract:

1. `message.author`:
- `id` (string)
- `name` (string)
- `isMe` (boolean)
2. `message.text` (optional string)
3. `message.attachments` (optional array)
4. `message.isMention` (optional boolean)

When a documented field exists for a decision, use it before custom parsing.

## Handler routing contract in this repo

1. `onNewMention(thread, message)`:
- treat as explicit mention path
- subscribe thread
- respond
2. `onSubscribedMessage(thread, message)`:
- use `message.isMention` for deterministic explicit-mention bypass
- only run passive classifier when `isMention` is false

## Adapter-specific optional fields in our code

Some fields are adapter additions and should be treated as optional:

1. `message.channelId`
2. `message.threadId`
3. `message.threadTs`
4. `message.runId`

Guard these with optional access and defaults. Do not assume presence in generic Chat SDK typings.

## No-guessing rules

1. Do not infer mention targets from plain display-name text when `message.isMention` is available.
2. Prefer explicit routing reasons in logs (`explicit mention`, classifier reason, classifier error).
3. If uncertain about a field in production payloads, add a temporary structured debug log and confirm shape before changing logic.

## Source links

- Chat SDK `Message` reference: https://chat-sdk.dev/docs/reference/core/message
- Chat SDK `onSubscribedMessage`: https://chat-sdk.dev/docs/reference/chat/on-subscribed-message
- Chat SDK `Chat` reference: https://chat-sdk.dev/docs/reference/chat
