# Queue

Shared helpers for signed background work on a queue.

- `sign.ts` signs and checks messages
- `callback.ts` builds the HTTP route and local-dev consumer

Plugins register named tasks. Core delivers them with these helpers and one
shared topic/callback.

Conversation work is different. It only wakes a conversation. Keep using
`sign` + `callback` there too.

## Provider

- `provider.ts` owns the `QueueProvider` contract and `getQueueProvider()`.
  Queue code calls `getQueueProvider()`, not a provider module. Today it
  always returns the Vercel provider.
- `vercel.ts` implements `QueueProvider`. It is the only module that imports
  `@vercel/queue`, and only `provider.ts` imports it. Two ast-grep rules
  enforce these boundaries.
- Shared types, such as `QueueMessageMetadata` and `QueueSendOptions`, live in
  `provider.ts`.
- `nitro.ts` still writes the Vercel `queue/v2beta` triggers into the build
  output. Those triggers are deploy config, not runtime calls.
