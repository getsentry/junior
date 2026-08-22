# Queue

Shared helpers for signed background work on Vercel Queue.

- `sign.ts` signs and checks messages
- `callback.ts` builds the HTTP route and local-dev consumer

Plugins register named jobs. Core delivers them with these helpers and one
shared topic/callback.

Conversation work is different. It only wakes a conversation. Keep using
`sign` + `callback` there too.
