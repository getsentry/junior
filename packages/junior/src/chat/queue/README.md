# Queue

Shared helpers for signed background work on Vercel Queue.

- `sign.ts` signs and checks messages
- `callback.ts` builds the HTTP route and local-dev consumer
- `job.ts` binds those for one kind of work message

Plugins register named jobs. Core uses these helpers to deliver and run them
with one sign/retry path.

Conversation work is different. It only wakes a conversation. Keep using
`sign` + `callback` there.

Set `maxDeliveries` on every simple work pipe.
