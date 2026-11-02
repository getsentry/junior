# Queue

Signed background work: plugin tasks and Conversation wakes. `sign.ts` signs
and checks messages. `callback.ts` builds the HTTP route and the local dev
consumer.

## Boundaries

- Call `getQueueProvider()` in `provider.ts`. Only `provider.ts` imports
  `vercel.ts`, and only `vercel.ts` imports `@vercel/queue`. ast-grep rules
  enforce this.
- `bullmq.ts` is local development only. It imports `bullmq` and `redis` by a
  variable name so bundlers keep them out of production.
  `apps/example/scripts/check-vercel-output.mjs` fails if they reach a
  deployed function.
- `bullmq.ts` keeps no Redis connection between `send()` calls. The
  `startWorker()` worker owns its client and closes it in `close()`.
- A Conversation wake carries no work. The mailbox owns the work.

## BullMQ Differences

- A BullMQ idempotency key drops a second send only while BullMQ keeps the
  first job.
- BullMQ renews the lock of a running job. It does not redeliver a slow job
  after `visibilityTimeoutSeconds`.
- BullMQ does not implement `registerDevConsumer`. It is only for providers
  that deliver in the sending process.
