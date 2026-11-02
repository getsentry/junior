# Queue

- `bullmq.ts` imports `bullmq` and `redis` by a variable name so bundlers keep
  them out of production. Do not change these to static imports.
- BullMQ is not Vercel Queues. Its idempotency key drops a second send only
  while BullMQ keeps the first job. It renews the lock of a running job and
  does not redeliver a slow job after `visibilityTimeoutSeconds`.
