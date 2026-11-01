# Queue

This module owns signed background work: plugin tasks and Conversation wakes.
`sign.ts` signs and checks messages. `callback.ts` builds the HTTP route and
the local dev consumer.

## Boundaries

- Queue code calls `getQueueProvider()` in `provider.ts`. Do not import a
  provider module directly.
- Only `vercel.ts` imports `@vercel/queue`, and only `provider.ts` imports
  `vercel.ts`. ast-grep rules enforce this.
- `bullmq.ts` is for local development only. It imports `bullmq` and `redis`
  by a variable name so bundlers keep them out of production.
  `apps/example/scripts/check-vercel-output.mjs` fails if they reach a
  deployed function.
- `bullmq.ts` keeps no Redis connection between `send()` calls. The worker
  from `startWorker()` owns its own client and closes it in `close()`.
- A Conversation wake carries no work. The mailbox owns the work.

## Provider differences

- Do not assume BullMQ behaves like Vercel Queues. A BullMQ idempotency key
  drops a second send only while BullMQ keeps the first job.
- BullMQ renews the lock of a running job. It does not redeliver a slow job
  after `visibilityTimeoutSeconds`.
- `registerDevConsumer` is only for providers that deliver in the sending
  process. BullMQ does not implement it.
