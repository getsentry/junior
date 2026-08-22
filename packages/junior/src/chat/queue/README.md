# Queue

Shared helpers for signed background work on Vercel Queue.

- `sign.ts` signs and checks messages
- `callback.ts` builds the HTTP route and local-dev consumer
- `job.ts` binds those for one simple job

Use `queueJob` when the message is the work unit. Keep each job's schema,
context, version, signed parts, topic, id, and run local.

Conversation work is different. It only wakes a conversation. Keep using
`sign` + `callback` there, not `queueJob`.

Set `maxDeliveries` on every simple job.
