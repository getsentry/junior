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
  Queue code calls `getQueueProvider()`, not a provider module.
  `JUNIOR_QUEUE_PROVIDER` selects the provider. The default is `vercel`.
- `vercel.ts` implements `QueueProvider`. It is the only module that imports
  `@vercel/queue`, and only `provider.ts` imports it. Two ast-grep rules
  enforce these boundaries.
- `bullmq.ts` implements `QueueProvider` with BullMQ on Redis, for local
  development only. `pnpm dev` selects it. Its workers start where
  `registerDevConsumer` runs, in the dev server process, and pull jobs from
  Redis. Nothing pushes to the callback routes.
- `bullmq.ts` imports `bullmq` and `redis` by a name in a variable, so
  bundlers do not put them into the production server.
  `apps/example/scripts/check-vercel-output.mjs` fails if they reach a
  deployed function.
- BullMQ is not the same as Vercel Queues. An idempotency key drops a second
  send only while BullMQ still stores the first job (one hour after it
  completes). BullMQ renews the lock of a running job, so it does not send a
  slow job again when `visibilityTimeoutSeconds` runs out.
- Shared types, such as `QueueMessageMetadata` and `QueueSendOptions`, live in
  `provider.ts`.
- `nitro.ts` still writes the Vercel `queue/v2beta` triggers into the build
  output. Those triggers are deploy config, not runtime calls.
